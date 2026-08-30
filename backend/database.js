import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { createConnection, getDbInstance, withTransaction } from './db/connection.js';
import { ensureSchema } from './db/schema.js';
import {
    getTagAliasesSnapshot,
    expandTagSearch,
    normalizeTagValue,
    splitTopicsToArray,
    replaceCardTagsForDatabase,
    replaceCardTags,
    rebuildCardTagsTable,
    shouldRebuildCardTags,
    searchTags,
    getRandomTags
} from './db/repositories/TagRepository.js';
import {
    upsertCard,
    getCards,
    getCardsByIdsOrdered,
    getAllLanguages,
    toggleFavorite,
    deleteCard,
    detectLanguage,
    backfillTokenCounts,
    LANGUAGE_MAPPING
} from './db/repositories/CardRepository.js';

const log = logger.scoped('DB');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_FILE = process.env.CHARACTER_ARCHIVE_DB_FILE
    || path.join(process.env.CHARACTER_ARCHIVE_STATE_DIR || path.join(__dirname, '..'), 'cards.db');

/**
 * Initialize database connection
 */
export function initDatabase(options = {}) {
    const {
        skipTagRebuild = false,
        skipTokenBackfill = false,
        skipSchemaMigrations = false
    } = options;

    try {
        const db = createConnection(DATABASE_FILE);

        if (!skipSchemaMigrations) {
            ensureSchema(db);
        }

        if (!skipTokenBackfill) {
            backfillTokenCounts(db).catch(error => {
                log.warn('Deferred token count backfill failed', error);
            });
        }

        if (!skipTagRebuild) {
            const { needsRebuild, reason } = shouldRebuildCardTags(db);
            if (needsRebuild) {
                log.info(`Rebuilding card_tags table (${reason})`);
                rebuildCardTagsTable(db);
            } else {
                log.info('card_tags table already in sync, skipping rebuild');
            }
        }

        log.info('Database initialized');
        return db;
    } catch (error) {
        log.error('Database init failed', error);
        throw error;
    }
}

/**

 * Get database instance

 */

export function getDatabase() {

    return getDbInstance();

}



export {

    withTransaction,

    searchTags,

    getRandomTags,

    getTagAliasesSnapshot,

    replaceCardTags,

    expandTagSearch,

    splitTopicsToArray,

    normalizeTagValue,

    upsertCard,

    getCards,

    getCardsByIdsOrdered,

    getAllLanguages,

    toggleFavorite,

    deleteCard,

    detectLanguage,

    LANGUAGE_MAPPING

};
