#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { initDatabase, getDatabase } from '../backend/database.js';
import { getVectorGenerationRepository } from '../backend/db/repositories/VectorGenerationRepository.js';
import { loadConfig } from '../config-loader.js';
import { logger } from '../backend/utils/logger.js';
import { parseVectorEtlResult, validateVectorEtlResult } from './vector-etl-contract.js';

const log = logger.scoped('VECTOR:WORKER');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const etlPath = path.join(__dirname, 'etl_cards_vector_search.js');
const workerId = process.env.VECTOR_WORKER_ID || `${os.hostname()}:${process.pid}`;
const batchSize = Math.max(1, Math.min(Number(process.env.VECTOR_WORKER_BATCH_SIZE) || 100, 250));
const pollMs = Math.max(500, Number(process.env.VECTOR_WORKER_POLL_MS) || 5000);
const maxTaskBacklog = Math.max(1, Number(process.env.VECTOR_MAX_MEILI_TASK_BACKLOG) || 200);
const runOnce = process.argv.includes('--once');
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const database = getDatabase();
const generations = getVectorGenerationRepository();

function specFromConfig(config) {
    return {
        modelName: config.vectorSearch?.embedModel,
        embedderName: config.vectorSearch?.embedderName,
        dimensions: Number(config.vectorSearch?.embedDimensions),
        cardsIndexBase: config.vectorSearch?.cardsIndex || 'cards_vsem',
        chunksIndexBase: config.vectorSearch?.chunksIndex || 'card_chunks',
        chunksEnabled: config.vectorSearch?.enableChunks !== false
    };
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
        EMBEDDING_TOKEN_BUDGET: '8000'
    };
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [etlPath], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        child.stdout.on('data', chunk => {
            process.stdout.write(chunk);
            stdout = `${stdout}${chunk}`.slice(-1_000_000);
        });
        child.stderr.on('data', chunk => process.stderr.write(chunk));
        child.once('error', reject);
        child.once('exit', (code, signal) => {
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
    const config = loadConfig();
    if (config.vectorSearch?.enabled !== true || config.meilisearch?.enabled !== true) return false;
    if (process.env.VECTOR_AUTO_RECONCILE !== '0') generations.reconcile(specFromConfig(config));
    const generation = generations.currentBuild();
    if (!generation) return false;

    const activeSync = database.prepare("SELECT id FROM sync_runs WHERE status = 'running' LIMIT 1").get();
    if (activeSync) {
        log.info(`Pausing vector work while sync run ${activeSync.id} is active`);
        return false;
    }
    const backlog = await meiliBacklog(config);
    if (backlog > maxTaskBacklog) {
        log.warn(`Pausing vector work: Meilisearch task backlog is ${backlog}`);
        return false;
    }
    if (Date.now() < circuitOpenUntil) return false;

    const items = generations.claimBatch({ generationId: generation.id, workerId, limit: batchSize, leaseSeconds: 900 });
    if (!items.length) return false;
    try {
        await runEtl(items, generation, config);
        generations.completeItems(items.map(item => item.id));
        consecutiveFailures = 0;
        circuitOpenUntil = 0;
        log.info(`Completed ${items.length} vector work items for generation ${generation.id}`);
    } catch (error) {
        generations.failItems(items.map(item => item.id), error, { maxAttempts: 5 });
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) circuitOpenUntil = Date.now() + 60000;
        log.error(`Vector batch failed for generation ${generation.id}`, error);
    }
    return true;
}

async function main() {
    do {
        try {
            await tick();
        } catch (error) {
            log.error('Vector worker tick failed', error);
        }
        if (runOnce) break;
        await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (true);
}

main().catch(error => {
    log.error('Vector worker stopped', error);
    process.exitCode = 1;
});
