import { loadConfig } from '../config-loader.js';
import { syncCards } from '../backend/services/scraper.js';
import { logger } from '../backend/utils/logger.js';
import { initDatabase } from '../backend/database.js';

const syncLogger = logger.scoped('SYNC_SCRIPT');

async function main() {
    const config = loadConfig();
    initDatabase();

    if (!config.apikey) {
        syncLogger.error('Chub API key is not configured. Please set `apikey` in config.json.');
        return;
    }

    try {
        syncLogger.info('Starting manual card sync...');
        const result = await syncCards(config, (progress) => {
            syncLogger.info(`Progress: ${progress.progress}% - Current Card: ${progress.currentCard} - New Cards: ${progress.newCards}`);
        });
        syncLogger.info(`Manual sync finished. New/updated cards: ${result.newCards}`);
    } catch (error) {
        syncLogger.error('Manual sync failed:', error);
    }
}

main();
