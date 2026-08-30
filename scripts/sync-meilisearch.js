#!/usr/bin/env node
import { MeiliSearch } from 'meilisearch';
import { loadConfig } from '../config-loader.js';
import { initDatabase, getDatabase } from '../backend/database.js';
import { configureSearchIndex, rebuildSearchIndexFromRows } from '../backend/services/search-index.js';

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
    const rows = database.prepare('SELECT * FROM cards').all();
    const documentsCount = rows.length;
    console.log(`[INFO] Loaded ${documentsCount} cards from SQLite`);

    configureSearchIndex(meili);
    await rebuildSearchIndexFromRows(rows);

    console.log('[INFO] Meilisearch sync complete');
    process.exit(0);
}

main().catch(error => {
    console.error('[ERROR] Failed to sync Meilisearch:', error?.message || error);
    process.exit(1);
});
