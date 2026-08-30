#!/usr/bin/env node

import { MeiliSearch } from 'meilisearch';
import { loadConfig } from '../config-loader.js';
import { initDatabase, getDatabase } from '../backend/database.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTask(taskClient, taskUid, timeoutMs = 60_000) {
    if (!taskClient || !taskUid) {
        return;
    }
    if (typeof taskClient.waitForTask === 'function') {
        await taskClient.waitForTask(taskUid, { timeOutMs: timeoutMs });
        return;
    }
    if (typeof taskClient.getTask !== 'function') {
        return;
    }
    const start = Date.now();
    while (true) {
        const task = await taskClient.getTask(taskUid);
        if (task.status === 'enqueued' || task.status === 'processing') {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for task ${taskUid}`);
            }
            await sleep(500);
            continue;
        }
        return;
    }
}

async function deleteIndexIfExists(client, taskClient, indexUid) {
    if (!indexUid) {
        return;
    }
    try {
        const task = await client.deleteIndex(indexUid);
        if (task?.taskUid) {
            await waitForTask(taskClient, task.taskUid);
        }
        console.log(`[INFO] Deleted Meilisearch index "${indexUid}"`);
    } catch (error) {
        const message = error?.message || String(error || '');
        if (message.includes('index_not_found') || message.includes('Index `') || message.includes('not found')) {
            console.warn(`[WARN] Index "${indexUid}" did not exist, skipping`);
            return;
        }
        throw error;
    }
}

async function clearChunkArtifacts(skip) {
    if (skip) {
        console.log('[INFO] Skipping local chunk artifact purge');
        return;
    }
    await initDatabase({ skipSchemaMigrations: true, skipTagRebuild: true, skipTokenBackfill: true });
    const db = getDatabase();
    const mapResult = db.prepare('DELETE FROM card_chunk_map').run();
    const metaResult = db.prepare('DELETE FROM card_embedding_meta WHERE chunk_index >= 0').run();
    console.log(`[INFO] Cleared chunk artifacts (card_chunk_map=${mapResult.changes || 0}, card_embedding_meta=${metaResult.changes || 0})`);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const keepChunks = args.has('--keep-chunks') || process.env.LCR_VECTOR_KEEP_CHUNKS === '1';
    const chunksOnly = args.has('--chunks-only') || process.env.LCR_VECTOR_CHUNKS_ONLY === '1';

    const config = loadConfig();
    const meiliCfg = config?.meilisearch || {};
    const vectorCfg = config?.vectorSearch || {};

    const host = (process.env.MEILI_HOST || meiliCfg.host || '').trim();
    if (!host) {
        console.error('[FATAL] Missing Meilisearch host. Set MEILI_HOST or config.meilisearch.host');
        process.exit(1);
    }

    const apiKey = (process.env.MEILI_KEY || meiliCfg.apiKey || meiliCfg.key || '').trim();
    if (!apiKey) {
        console.error('[FATAL] Missing Meilisearch API key. Set MEILI_KEY or config.meilisearch.apiKey');
        process.exit(1);
    }

    const cardsIndex = (process.env.MEILI_CARDS_INDEX || vectorCfg.cardsIndex || 'cards_vsem').trim();
    const chunksIndex = (process.env.MEILI_CHUNKS_INDEX || vectorCfg.chunksIndex || 'card_chunks').trim();

    console.log(`[INFO] Connecting to Meilisearch at ${host}`);
    const client = new MeiliSearch({ host, apiKey });

    const taskClient = client.tasks;

    if (!chunksOnly) {
        await deleteIndexIfExists(client, taskClient, cardsIndex);
    }
    await deleteIndexIfExists(client, taskClient, chunksIndex);

    await clearChunkArtifacts(keepChunks);

    if (chunksOnly) {
        console.log('[INFO] Chunk vector artifacts flushed. Chunk indexing will stay gone until chunk vectors are re-enabled and backfilled.');
    } else {
        console.log('[INFO] Vector indexes flushed. Run `npm run vector:backfill` (optionally with LCR_VECTOR_FORCE=1) to rebuild.');
    }
    process.exit(0);
}

main().catch(error => {
    console.error('[FATAL] Failed to flush vector indexes:', error?.message || error);
    process.exit(1);
});
