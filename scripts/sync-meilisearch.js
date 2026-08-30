#!/usr/bin/env node
import { MeiliSearch } from 'meilisearch';
import { loadConfig } from '../config-loader.js';
import { initDatabase, getDatabase } from '../backend/database.js';
import {
    buildSearchDocumentFromRow,
    configureSearchIndex,
    rebuildSearchIndexFromDocumentBatches
} from '../backend/services/search-index.js';

async function* documentBatches(database, batchSize = 1000) {
    const selectBatch = database.prepare('SELECT * FROM cards WHERE id > ? ORDER BY id LIMIT ?');
    let lastId = -1;
    while (true) {
        const rows = selectBatch.all(lastId, batchSize);
        if (!rows.length) return;
        lastId = Number(rows.at(-1).id);
        const documents = rows.map(buildSearchDocumentFromRow).filter(Boolean);
        if (documents.length) yield documents;
    }
}

async function main() {
    const config = loadConfig();
    const meili = config.meilisearch || {};

    if (!meili.enabled) {
        console.error('[ERROR] Meilisearch is not enabled in config.json');
        process.exit(1);
    }

    const host = (meili.host || '').trim();
    if (!host) {
        console.error('[ERROR] meilisearch.host is required');
        process.exit(1);
    }

    const indexName = (meili.indexName || 'cards').trim() || 'cards';

    console.log(`[INFO] Connecting to Meilisearch at ${host}, index "${indexName}"`);
    const client = new MeiliSearch({ host, apiKey: meili.apiKey || undefined });
    try {
        await client.createIndex(indexName, { primaryKey: 'id' });
    } catch (error) {
        if (!String(error?.message || '').includes('already exists')) {
            throw error;
        }
    }

    await initDatabase();
    const database = getDatabase();
    const documentsCount = Number(database.prepare('SELECT COUNT(*) AS count FROM cards').get()?.count || 0);
    console.log(`[INFO] Streaming ${documentsCount} cards from SQLite`);

    configureSearchIndex(meili);
    await rebuildSearchIndexFromDocumentBatches(documentBatches(database), { expectedDocuments: documentsCount });

    console.log('[INFO] Meilisearch sync complete');
    process.exit(0);
}

main().catch(error => {
    console.error('[ERROR] Failed to sync Meilisearch:', error?.message || error);
    process.exit(1);
});
