#!/usr/bin/env node
import { loadConfig } from '../config-loader.js';
import { LanceSearchBackend } from '../backend/services/search/LanceSearchBackend.js';
import { configuredProvider } from '../backend/services/SearchService.js';
import { logger } from '../backend/utils/logger.js';

const log = logger.scoped('SEARCH:MAINTENANCE');
const once = process.argv.includes('--once');
const intervalMs = Math.max(60000, Number(process.env.SEARCH_MAINTENANCE_INTERVAL_MS) || 1800000);
let stopping = false;
let wake;
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { stopping = true; wake?.(); });
}

async function main() {
    do {
        const config = loadConfig();
        if (configuredProvider(config) === 'lancedb') {
            const backend = new LanceSearchBackend({
                uri: process.env.SEARCH_LANCE_PATH || config.search?.lancedb?.uri,
                tableName: config.search?.lancedb?.tableName
            });
            try {
                log.info('Compacting lexical search table and updating indexes');
                const stats = await backend.optimize();
                log.info('Search maintenance complete', stats);
            } catch (error) {
                log.error('Search maintenance failed; will retry at the next interval', error);
                if (once) process.exitCode = 1;
            } finally {
                await backend.close();
            }
        }
        if (once || stopping) break;
        await new Promise(resolve => {
            const timer = setTimeout(resolve, intervalMs);
            wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = null;
    } while (!stopping);
}
main().catch(error => { log.error('Maintenance worker stopped', error); process.exitCode = 1; });
