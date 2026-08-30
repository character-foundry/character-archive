import path from 'node:path';

import { getDatabase } from '../database.js';
import { logger } from '../utils/logger.js';
import * as meili from './search-index.js';
import { LanceSearchBackend } from './search/LanceSearchBackend.js';

const log = logger.scoped('SEARCH:SERVICE');
const DEFAULT_STATE_DIR = process.env.CHARACTER_ARCHIVE_STATE_DIR || process.cwd();

let activeProvider = 'disabled';
let lanceBackend = null;
let searchConfig = null;
let queueDrainInFlight = false;
let refreshInFlight = false;
let refreshQueued = false;

export function configuredProvider(config = {}) {
    if (config.search?.enabled === false) return 'disabled';
    const environmentProvider = String(process.env.SEARCH_BACKEND || '').trim().toLowerCase();
    if (environmentProvider === 'lancedb' || environmentProvider === 'meilisearch') return environmentProvider;
    const explicit = String(config.search?.backend || '').trim().toLowerCase();
    if (config.search?.enabled === true && (explicit === 'lancedb' || explicit === 'meilisearch')) return explicit;
    return config.meilisearch?.enabled === true ? 'meilisearch' : 'disabled';
}

function createLanceBackend(config = {}) {
    const lance = config.search?.lancedb || {};
    const uri = process.env.SEARCH_LANCE_PATH
        || lance.uri
        || path.join(DEFAULT_STATE_DIR, 'search.lance');
    return new LanceSearchBackend({
        uri,
        tableName: lance.tableName || 'cards',
        vectorTableName: config.vectorSearch?.cardsIndex || 'card_vectors',
        vectorConfig: config.vectorSearch || {},
        batchSize: lance.batchSize,
        maxTotalHits: lance.maxTotalHits
    });
}

export async function assertSearchBackendReady(config = {}) {
    const provider = configuredProvider(config);
    if (provider !== 'lancedb') return true;
    const candidate = createLanceBackend(config);
    try {
        if (!await candidate.isReady()) {
            throw new Error('LanceDB search index is not built and activated; run pnpm sync:search before switching providers');
        }
        return true;
    } finally {
        await candidate.close();
    }
}

export function configureSearchBackend(config = {}) {
    const previousLanceBackend = lanceBackend;
    lanceBackend = null;
    previousLanceBackend?.close().catch(error => log.warn('Failed to close the previous LanceDB connection', error));
    searchConfig = config;
    activeProvider = configuredProvider(config);
    meili.configureSearchIndex(config.meilisearch || {});
    meili.configureVectorSearch(config.vectorSearch || {});

    if (activeProvider === 'lancedb') {
        lanceBackend = createLanceBackend(config);
        const uri = lanceBackend.uri;
        lanceBackend.probeVectorReady().catch(error => log.debug('LanceDB vector table is not ready', error.message));
        log.info(`Search provider: LanceDB (${uri})`);
    } else {
        lanceBackend = null;
        if (activeProvider === 'meilisearch') log.info('Search provider: Meilisearch');
        else log.info('Advanced search is disabled');
    }
    return activeProvider;
}

export function getSearchProvider() {
    return activeProvider;
}

export function isSearchIndexEnabled() {
    if (activeProvider === 'lancedb') return Boolean(lanceBackend?.enabled);
    if (activeProvider === 'meilisearch') return meili.isSearchIndexEnabled();
    return false;
}

export function isVectorSearchReady() {
    if (activeProvider === 'meilisearch') return meili.isVectorSearchReady();
    return Boolean(activeProvider === 'lancedb' && lanceBackend?.vectorReady);
}

export async function ensureVectorBackend() {
    if (activeProvider === 'meilisearch') return meili.ensureVectorEmbedders();
    return false;
}

export async function searchLexicalCards(options = {}) {
    if (activeProvider === 'lancedb') return lanceBackend.searchLexical(options);
    if (activeProvider === 'meilisearch') return meili.searchMeilisearchCards(options);
    throw new Error('Advanced search is not enabled');
}

export async function searchVectorCards(options = {}) {
    if (activeProvider === 'lancedb') return lanceBackend.searchVector(options);
    if (activeProvider === 'meilisearch') return meili.searchVectorCards(options);
    throw new Error('Vector search is not enabled');
}

export async function upsertSearchDocuments(documents = []) {
    if (activeProvider === 'lancedb') return lanceBackend.upsertDocuments(documents);
    if (activeProvider === 'meilisearch') return meili.indexDocuments(documents);
}

export async function deleteSearchDocuments(ids = []) {
    if (activeProvider === 'lancedb') return lanceBackend.deleteDocumentsByIds(ids);
    if (activeProvider === 'meilisearch') return meili.deleteDocumentsByIds(ids);
}

export async function processIndexQueue({ batchSize = 500 } = {}) {
    if (!isSearchIndexEnabled()) return { processed: 0, hasMore: false };
    const database = getDatabase();
    const rows = database.prepare(
        'SELECT id, cardId, action FROM search_index_queue ORDER BY id LIMIT ?'
    ).all(batchSize);
    if (!rows.length) return { processed: 0, hasMore: false };

    const jobs = new Map();
    for (const row of rows) jobs.set(String(row.cardId), row.action === 'delete' ? 'delete' : 'upsert');
    const upsertIds = [];
    const deleteIds = [];
    for (const [cardId, action] of jobs) (action === 'delete' ? deleteIds : upsertIds).push(cardId);

    if (deleteIds.length) await deleteSearchDocuments(deleteIds);
    if (upsertIds.length) {
        const placeholders = upsertIds.map(() => '?').join(', ');
        const cardRows = database.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...upsertIds);
        await upsertSearchDocuments(cardRows.map(meili.buildSearchDocumentFromRow).filter(Boolean));
    }

    const rowIds = rows.map(row => row.id);
    const placeholders = rowIds.map(() => '?').join(', ');
    database.prepare(`DELETE FROM search_index_queue WHERE id IN (${placeholders})`).run(...rowIds);
    return { processed: rows.length, hasMore: rows.length === batchSize };
}

export async function rebuildSearchIndexFromRows(rows = []) {
    const documents = Array.isArray(rows) ? rows.map(meili.buildSearchDocumentFromRow).filter(Boolean) : [];
    if (activeProvider === 'lancedb') return lanceBackend.rebuild(documents);
    if (activeProvider === 'meilisearch') return meili.rebuildSearchIndexFromRows(rows);
    throw new Error('Advanced search is not enabled');
}

async function* searchDocumentBatches(database, batchSize) {
    const selectBatch = database.prepare('SELECT * FROM cards WHERE id > ? ORDER BY id LIMIT ?');
    let lastId = -1;
    while (true) {
        const rows = selectBatch.all(lastId, batchSize);
        if (!rows.length) return;
        lastId = Number(rows.at(-1).id);
        const documents = rows.map(meili.buildSearchDocumentFromRow).filter(Boolean);
        if (documents.length) yield documents;
    }
}

export async function rebuildSearchIndexFromDatabase({ batchSize } = {}) {
    if (!isSearchIndexEnabled()) throw new Error('Advanced search is not enabled');
    const database = getDatabase();
    const resolvedBatchSize = Math.max(100, Number(batchSize || lanceBackend?.batchSize || 1000));
    const total = Number(database.prepare('SELECT COUNT(*) AS count FROM cards').get()?.count || 0);
    const batches = searchDocumentBatches(database, resolvedBatchSize);
    if (activeProvider === 'lancedb') return lanceBackend.rebuildBatches(batches);
    if (activeProvider === 'meilisearch') {
        return meili.rebuildSearchIndexFromDocumentBatches(batches, { expectedDocuments: total });
    }
    throw new Error('Advanced search is not enabled');
}

export async function runSearchIndexRefresh(reason = 'manual') {
    if (!isSearchIndexEnabled()) return;
    if (refreshInFlight) {
        refreshQueued = true;
        return;
    }
    refreshInFlight = true;
    try {
        const result = await rebuildSearchIndexFromDatabase();
        log.info(`${activeProvider} search index refreshed (${result?.documents ?? 0} docs) [reason=${reason}]`);
    } catch (error) {
        log.error(`Failed to refresh ${activeProvider} search index (${reason})`, error);
        throw error;
    } finally {
        refreshInFlight = false;
        if (refreshQueued) {
            refreshQueued = false;
            runSearchIndexRefresh('queued').catch(() => {});
        }
    }
}

export function triggerSearchIndexRefresh(reason = 'manual') {
    if (isSearchIndexEnabled()) runSearchIndexRefresh(reason).catch(() => {});
}

export async function drainSearchIndexQueue(reason = 'manual') {
    if (!isSearchIndexEnabled() || queueDrainInFlight) return;
    queueDrainInFlight = true;
    try {
        let totalProcessed = 0;
        let hasMore = false;
        let iterations = 0;
        do {
            const result = await processIndexQueue();
            totalProcessed += result.processed || 0;
            hasMore = Boolean(result.hasMore);
            iterations += 1;
        } while (hasMore && iterations < 5);
        if (totalProcessed) log.info(`${activeProvider} incremental update processed ${totalProcessed} jobs [reason=${reason}]`);
    } catch (error) {
        log.error(`Failed to process ${activeProvider} search queue (${reason})`, error);
    } finally {
        queueDrainInFlight = false;
    }
}

export function getVectorRuntimeStatus() {
    if (activeProvider === 'meilisearch') return { provider: activeProvider, ...meili.getVectorRuntimeStatus() };
    return {
        provider: activeProvider,
        configured: Boolean(searchConfig?.vectorSearch?.enabled),
        ready: Boolean(lanceBackend?.vectorReady),
        cardsIndex: searchConfig?.vectorSearch?.cardsIndex || 'card_vectors',
        chunksIndex: null,
        model: searchConfig?.vectorSearch?.embedModel,
        embedder: searchConfig?.vectorSearch?.embedderName,
        dimensions: searchConfig?.vectorSearch?.embedDimensions,
        embeddingCircuit: {
            consecutiveFailures: 0,
            open: false,
            openUntil: null,
            lastError: null
        }
    };
}

export function getSearchRuntimeStatus() {
    return {
        provider: activeProvider,
        enabled: isSearchIndexEnabled(),
        vector: getVectorRuntimeStatus()
    };
}

export async function closeSearchBackend() {
    await lanceBackend?.close();
}
