#!/usr/bin/env node

import { MeiliSearch } from 'meilisearch';
import { loadConfig } from '../config-loader.js';

function readBooleanFlag(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTask(taskClient, taskUid, timeoutMs = 60_000, label = 'Meili task') {
    if (!taskClient || !taskUid) return;
    if (typeof taskClient.getTask !== 'function') {
        if (typeof taskClient.waitForTask === 'function') {
            await taskClient.waitForTask(taskUid, { timeOutMs: timeoutMs });
        }
        return;
    }
    const start = Date.now();
    let lastLog = 0;
    while (true) {
        const task = await taskClient.getTask(taskUid);
        const status = task?.status || 'unknown';
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        if (Date.now() - lastLog > 2000) {
            console.log(`[INFO] ${label} ${taskUid} status=${status} elapsed=${elapsedSec}s`);
            lastLog = Date.now();
        }
        if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
            return;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for task ${taskUid} after ${elapsedSec}s (status=${status})`);
        }
        await sleep(500);
    }
}

function isIndexMissing(error) {
    const message = String(error?.message || '');
    return message.includes('index_not_found') || message.includes('not found');
}

async function ensureIndex(client, indexUid, primaryKey = 'id') {
    if (!indexUid) {
        throw new Error('Missing index UID');
    }
    try {
        await client.getIndex(indexUid);
    } catch (error) {
        if (!isIndexMissing(error)) {
            throw error;
        }
        await client.createIndex(indexUid, { primaryKey });
    }
    return client.index(indexUid);
}

async function hasPendingSettingsUpdate(client, indexUid) {
    if (!client?.tasks || typeof client.tasks.getTasks !== 'function') {
        return false;
    }
    const uid = (indexUid || '').trim();
    if (!uid) return false;
    try {
        const tasks = await client.tasks.getTasks({
            indexUids: [uid],
            types: ['settingsUpdate'],
            statuses: ['enqueued', 'processing'],
            limit: 1
        });
        const results = Array.isArray(tasks?.results) ? tasks.results : [];
        return results.length > 0;
    } catch (error) {
        console.warn('[WARN] Failed to check Meilisearch task queue:', error?.message || error);
        return false;
    }
}

async function ensureEmbedder(indexUid, embedderName, dimensions, client) {
    if (!indexUid) return;
    if (!embedderName) {
        throw new Error('Embedder name is missing. Set vectorSearch.embedderName or MEILI_EMBEDDER.');
    }
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
        throw new Error('Embed dimensions missing. Set vectorSearch.embedDimensions or EMBED_DIMENSIONS.');
    }

    const index = await ensureIndex(client, indexUid, 'id');
    let settings = {};
    try {
        settings = await index.getSettings();
    } catch (error) {
        console.warn(`[WARN] Failed to read settings for ${indexUid}: ${error?.message || error}`);
    }

    const embedders = settings?.embedders || {};
    const current = embedders[embedderName];
    const currentDims = Number(current?.dimensions);
    if (current && Number.isFinite(currentDims) && currentDims === dimensions) {
        console.log(`[INFO] ${indexUid}: embedder "${embedderName}" already set (${dimensions}d)`);
        return;
    }
    const pending = await hasPendingSettingsUpdate(client, indexUid);
    if (pending) {
        console.log(`[WARN] ${indexUid}: settings update already pending; skipping new update.`);
        return;
    }

    const task = await index.updateSettings({
        embedders: {
            ...embedders,
            [embedderName]: {
                source: 'userProvided',
                dimensions
            }
        }
    });
    const taskId = task?.taskUid ?? task?.uid;
    if (taskId) {
        await waitForTask(client.tasks, taskId, 60_000, `Meili settings (${indexUid})`).catch(error => {
            console.warn(`[WARN] Timed out waiting for task ${taskId}: ${error?.message || error}`);
        });
    }
    console.log(`[INFO] ${indexUid}: embedder "${embedderName}" set to ${dimensions}d`);
}

async function main() {
    const config = loadConfig();
    const meili = config?.meilisearch || {};
    const vector = config?.vectorSearch || {};

    const host = (process.env.MEILI_HOST || meili.host || '').trim();
    if (!host) {
        console.error('[FATAL] Missing Meilisearch host. Set MEILI_HOST or config.meilisearch.host');
        process.exit(1);
    }
    const apiKey = (process.env.MEILI_KEY || meili.apiKey || meili.key || '').trim();
    if (!apiKey) {
        console.error('[FATAL] Missing Meilisearch API key. Set MEILI_KEY or config.meilisearch.apiKey');
        process.exit(1);
    }

    const embedderName = (process.env.MEILI_EMBEDDER || vector.embedderName || '').trim();
    const dimensions = Number(process.env.EMBED_DIMENSIONS || vector.embedDimensions || 0);
    const cardsIndex = (process.env.MEILI_CARDS_INDEX || vector.cardsIndex || 'cards_vsem').trim();
    const chunksIndex = (process.env.MEILI_CHUNKS_INDEX || vector.chunksIndex || 'card_chunks').trim();
    const enableChunks = readBooleanFlag(process.env.MEILI_ENABLE_CHUNKS, vector.enableChunks !== false);

    console.log(`[INFO] Ensuring embedders for ${cardsIndex}${enableChunks ? ` / ${chunksIndex}` : ' (chunks disabled)'} on ${host}`);

    const client = new MeiliSearch({ host, apiKey });
    await ensureEmbedder(cardsIndex, embedderName, dimensions, client);
    if (enableChunks) {
        await ensureEmbedder(chunksIndex, embedderName, dimensions, client);
    }

    console.log('[INFO] Embedder settings verified');
    process.exit(0);
}

main().catch(error => {
    console.error('[FATAL] Failed to ensure embedders:', error?.message || error);
    process.exit(1);
});
