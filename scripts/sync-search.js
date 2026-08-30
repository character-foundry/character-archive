#!/usr/bin/env node

import { initDatabase } from '../backend/database.js';
import { configureSearchBackend, getSearchProvider, rebuildSearchIndexFromDatabase } from '../backend/services/SearchService.js';
import { loadConfig } from '../config-loader.js';

async function main() {
    initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
    const config = loadConfig();
    configureSearchBackend(config);
    const provider = getSearchProvider();
    if (provider === 'disabled') throw new Error('Search is disabled in config.json');
    console.log(`[SEARCH] Rebuilding ${provider} from SQLite in bounded batches`);
    const result = await rebuildSearchIndexFromDatabase();
    console.log(`[SEARCH] Rebuilt ${provider}: ${result.documents} documents`);
}

main().catch(error => {
    console.error('[SEARCH] Rebuild failed:', error);
    process.exitCode = 1;
});
