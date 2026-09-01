#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { initDatabase, getDatabase } from '../backend/database.js';
import { getVectorGenerationRepository } from '../backend/db/repositories/VectorGenerationRepository.js';
import { loadConfig } from '../config-loader.js';
import { logger } from '../backend/utils/logger.js';
import { LanceSearchBackend } from '../backend/services/search/LanceSearchBackend.js';
import { parseVectorEtlResult, validateVectorEtlResult } from './vector-etl-contract.js';
import { drainDecision, shouldPauseForArchiveSync } from './vector-worker-policy.js';

const log = logger.scoped('VECTOR:WORKER');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const meiliEtlPath = path.join(__dirname, 'etl_cards_vector_search.js');
const lanceEtlPath = path.join(__dirname, 'etl_cards_lancedb.js');
const workerId = process.env.VECTOR_WORKER_ID || `${os.hostname()}:${process.pid}`;
const batchSize = Math.max(1, Math.min(Number(process.env.VECTOR_WORKER_BATCH_SIZE) || 100, 250));
const pollMs = Math.max(500, Number(process.env.VECTOR_WORKER_POLL_MS) || 5000);
const maxTaskBacklog = Math.max(1, Number(process.env.VECTOR_MAX_MEILI_TASK_BACKLOG) || 200);
const configuredOptimizeInterval = Number(process.env.VECTOR_LANCE_OPTIMIZE_EVERY_BATCHES);
const lanceOptimizeEveryBatches = Number.isFinite(configuredOptimizeInterval)
    ? Math.max(0, Math.floor(configuredOptimizeInterval))
    : 20;
const runOnce = process.argv.includes('--once');
const drainMode = process.argv.includes('--drain');
const drainStartedAt = Date.now();
const drainMaxMinutes = Math.max(1, Number(process.env.VECTOR_DRAIN_MAX_MINUTES) || 360);
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lanceBatchesSinceOptimize = 0;
let stopping = false;
let activeChild = null;
let forceKillTimer = null;

initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const database = getDatabase();
const generations = getVectorGenerationRepository();

function searchProvider(config) {
    const environmentProvider = String(process.env.SEARCH_BACKEND || '').trim().toLowerCase();
    if (environmentProvider === 'lancedb' || environmentProvider === 'meilisearch') return environmentProvider;
    const provider = String(config.search?.backend || '').trim().toLowerCase();
    if (config.search?.enabled === true && (provider === 'lancedb' || provider === 'meilisearch')) return provider;
    return config.meilisearch?.enabled === true ? 'meilisearch' : 'disabled';
}

function specFromConfig(config) {
    const provider = searchProvider(config);
    const configuredEmbedder = config.vectorSearch?.embedderName;
    return {
        modelName: config.vectorSearch?.embedModel,
        embedderName: provider === 'lancedb' && !String(configuredEmbedder).startsWith('lance-')
            ? `lance-${configuredEmbedder}`
            : configuredEmbedder,
        dimensions: Number(config.vectorSearch?.embedDimensions),
        cardsIndexBase: config.vectorSearch?.cardsIndex || 'cards_vsem',
        chunksIndexBase: provider === 'lancedb' ? '' : (config.vectorSearch?.chunksIndex || 'card_chunks'),
        chunksEnabled: provider === 'lancedb' ? false : config.vectorSearch?.enableChunks !== false
    };
}

function matchesSpec(generation, spec) {
    return generation.model_name === spec.modelName
        && generation.embedder_name === spec.embedderName
        && Number(generation.dimensions) === Number(spec.dimensions)
        && Boolean(generation.chunks_index) === (spec.chunksIndexBase !== '' && spec.chunksEnabled !== false);
}

function failedGeneration(spec) {
    return generations.list().find(generation => (
        generation.status === 'failed' && matchesSpec(generation, spec)
    )) || null;
}

async function meiliBacklog(config) {
    const host = String(process.env.MEILI_HOST || config.meilisearch?.host || '').replace(/\/$/, '');
    if (!host) return 0;
    const apiKey = process.env.MEILI_KEY || config.meilisearch?.apiKey || '';
    const params = new URLSearchParams({ limit: '1' });
    params.append('statuses', 'enqueued');
    params.append('statuses', 'processing');
    const response = await fetch(`${host}/tasks?${params}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Meilisearch backlog check failed: ${response.status}`);
    const payload = await response.json();
    return Number(payload.total || payload.results?.length || 0);
}

function runEtl(items, generation, config) {
    const upserts = items.filter(item => item.action === 'upsert').map(item => item.card_id);
    const deletes = items.filter(item => item.action === 'delete').map(item => item.card_id);
    const provider = searchProvider(config);
    const env = {
        ...process.env,
        LCR_VECTOR_IDS: upserts.join(','),
        LCR_VECTOR_DELETE_IDS: deletes.join(','),
        LCR_VECTOR_FORCE: '1',
        MEILI_CARDS_INDEX: generation.cards_index,
        MEILI_CHUNKS_INDEX: generation.chunks_index || '',
        MEILI_ENABLE_CHUNKS: generation.chunks_index ? '1' : '0',
        EMBED_MODEL: generation.model_name,
        MEILI_EMBEDDER: generation.embedder_name,
        EMBED_DIMENSIONS: String(generation.dimensions),
        EMBEDDING_PROVIDER: config.vectorSearch?.embeddingProvider || 'openai',
        EMBEDDING_URL: config.vectorSearch?.embeddingUrl || config.vectorSearch?.ollamaUrl || '',
        EMBEDDING_API_KEY: config.vectorSearch?.embeddingApiKey || '',
        MEILI_HOST: config.meilisearch?.host || '',
        MEILI_KEY: config.meilisearch?.apiKey || '',
        SEARCH_LANCE_PATH: process.env.SEARCH_LANCE_PATH || config.search?.lancedb?.uri || '',
        LANCE_VECTOR_TABLE: generation.cards_index,
        EMBEDDING_TOKEN_BUDGET: '8000'
    };
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [provider === 'lancedb' ? lanceEtlPath : meiliEtlPath], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        activeChild = child;
        let stdout = '';
        child.stdout.on('data', chunk => {
            process.stdout.write(chunk);
            stdout = `${stdout}${chunk}`.slice(-1_000_000);
        });
        child.stderr.on('data', chunk => process.stderr.write(chunk));
        const clearActiveChild = () => {
            if (activeChild === child) activeChild = null;
            if (forceKillTimer) clearTimeout(forceKillTimer);
            forceKillTimer = null;
        };
        child.once('error', error => {
            clearActiveChild();
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearActiveChild();
            if (code !== 0) {
                reject(new Error(`Vector ETL exited ${code}${signal ? ` (${signal})` : ''}`));
                return;
            }
            try {
                const result = parseVectorEtlResult(stdout);
                resolve(validateVectorEtlResult(result, {
                    upsertCount: upserts.length,
                    deleteCount: deletes.length,
                    forceReembed: true
                }));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function tick() {
    if (stopping) return false;
    const config = loadConfig();
    const provider = searchProvider(config);
    if (config.vectorSearch?.enabled !== true || provider === 'disabled') return false;
    if (provider === 'meilisearch' && config.meilisearch?.enabled !== true) return false;
    const spec = specFromConfig(config);
    let generation = generations.currentBuild(spec);
    if (!generation && process.env.VECTOR_AUTO_RECONCILE !== '0' && !failedGeneration(spec)) {
        generations.reconcile(spec);
        generation = generations.currentBuild(spec);
    }
    if (!generation) return false;

    if (shouldPauseForArchiveSync({ provider, setting: process.env.VECTOR_PAUSE_DURING_SYNC })) {
        const activeSync = database.prepare("SELECT id FROM sync_runs WHERE status = 'running' LIMIT 1").get();
        if (activeSync) {
            log.info(`Pausing vector work while sync run ${activeSync.id} is active`);
            return false;
        }
    }
    if (provider === 'meilisearch') {
        const backlog = await meiliBacklog(config);
        if (backlog > maxTaskBacklog) {
            log.warn(`Pausing vector work: Meilisearch task backlog is ${backlog}`);
            return false;
        }
    }
    if (Date.now() < circuitOpenUntil) return false;
    if (stopping) return false;

    const items = generations.claimBatch({ generationId: generation.id, workerId, limit: batchSize, leaseSeconds: 900 });
    if (!items.length) {
        generations.refreshProgress(generation.id);
        return false;
    }
    try {
        await runEtl(items, generation, config);
        const pendingBeforeClaim = generation.queued_items + generation.retry_items + generation.running_items;
        if (provider === 'lancedb' && pendingBeforeClaim <= items.length && generation.dead_items === 0) {
            const lance = new LanceSearchBackend({
                uri: process.env.SEARCH_LANCE_PATH || config.search?.lancedb?.uri,
                vectorTableName: generation.cards_index,
                vectorConfig: { ...config.vectorSearch, enabled: true, embedDimensions: generation.dimensions }
            });
            try {
                await lance.ensureVectorIndex({ tableName: generation.cards_index });
            } finally {
                await lance.close();
            }
        }
        generations.completeItems(items.map(item => item.id));
        consecutiveFailures = 0;
        circuitOpenUntil = 0;
        log.info(`Completed ${items.length} vector work items for generation ${generation.id}`);
        if (provider === 'lancedb' && lanceOptimizeEveryBatches > 0) {
            lanceBatchesSinceOptimize += 1;
            if (lanceBatchesSinceOptimize >= lanceOptimizeEveryBatches) {
                const lance = new LanceSearchBackend({
                    uri: process.env.SEARCH_LANCE_PATH || config.search?.lancedb?.uri,
                    vectorTableName: generation.cards_index,
                    vectorConfig: { ...config.vectorSearch, enabled: true, embedDimensions: generation.dimensions }
                });
                try {
                    const stats = await lance.optimizeVector({
                        tableName: generation.cards_index,
                        cleanupOlderThan: new Date(),
                        deleteUnverified: true
                    });
                    lanceBatchesSinceOptimize = 0;
                    log.info(`Optimized LanceDB vector table ${generation.cards_index}`, stats);
                } catch (error) {
                    log.error(`Failed to optimize LanceDB vector table ${generation.cards_index}; will retry`, error);
                } finally {
                    try {
                        await lance.close();
                    } catch (error) {
                        log.error(`Failed to close optimized LanceDB vector table ${generation.cards_index}`, error);
                    }
                }
            }
        }
    } catch (error) {
        if (stopping) {
            const released = generations.releaseItems(items.map(item => item.id));
            log.info(`Released ${released} vector work items during shutdown`);
            return false;
        }
        generations.failItems(items.map(item => item.id), error, { maxAttempts: 5 });
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) circuitOpenUntil = Date.now() + 60000;
        log.error(`Vector batch failed for generation ${generation.id}`, error);
    }
    return true;
}

async function main() {
    do {
        let worked = false;
        try {
            worked = await tick();
        } catch (error) {
            log.error('Vector worker tick failed', error);
        }
        if (runOnce) break;
        if (stopping) break;
        const config = loadConfig();
        const spec = config.vectorSearch?.enabled === true ? specFromConfig(config) : null;
        const generation = spec ? (generations.currentBuild(spec) || failedGeneration(spec)) : null;
        const decision = drainDecision({
            enabled: drainMode,
            worked,
            generation,
            deadlineReached: Date.now() - drainStartedAt >= drainMaxMinutes * 60_000
        });
        if (decision === 'complete') {
            log.info('Finite vector drain is complete; exiting');
            break;
        }
        if (decision === 'timeout') {
            log.error(`Finite vector drain exceeded ${drainMaxMinutes} minutes; exiting without restart`);
            process.exitCode = 2;
            break;
        }
        if (decision === 'failed') {
            log.error(`Finite vector drain failed with ${generation?.dead_items || 0} dead work items; exiting without restart`);
            process.exitCode = 1;
            break;
        }
        if (!worked) await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (!stopping);
}

function requestStop(signal) {
    if (stopping) return;
    stopping = true;
    log.info(`Received ${signal}; stopping vector worker`);
    if (activeChild) {
        activeChild.kill('SIGTERM');
        forceKillTimer = setTimeout(() => activeChild?.kill('SIGKILL'), 3000);
        forceKillTimer.unref();
    }
}

process.once('SIGTERM', () => requestStop('SIGTERM'));
process.once('SIGINT', () => requestStop('SIGINT'));

main().catch(error => {
    log.error('Vector worker stopped', error);
    process.exitCode = 1;
});
