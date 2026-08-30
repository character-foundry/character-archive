#!/usr/bin/env node

import { initDatabase, getDatabase } from '../backend/database.js';
import { requestEmbeddings } from '../backend/services/EmbeddingClient.js';
import { buildSearchDocumentFromRow } from '../backend/services/search-index.js';
import { LanceSearchBackend, normalizeLanceDocument } from '../backend/services/search/LanceSearchBackend.js';
import { loadConfig } from '../config-loader.js';
import { VECTOR_RESULT_PREFIX } from './vector-etl-contract.js';

const config = loadConfig();
const vectorConfig = config.vectorSearch || {};
const lanceConfig = config.search?.lancedb || {};
const uri = process.env.SEARCH_LANCE_PATH || lanceConfig.uri || `${process.env.CHARACTER_ARCHIVE_STATE_DIR || process.cwd()}/search.lance`;
const tableName = process.env.LANCE_VECTOR_TABLE || vectorConfig.cardsIndex || 'card_vectors';
const dimensions = Number(process.env.EMBED_DIMENSIONS || vectorConfig.embedDimensions);
const embeddingProvider = process.env.EMBEDDING_PROVIDER || vectorConfig.embeddingProvider || 'ollama';
const embeddingUrl = process.env.EMBEDDING_URL || vectorConfig.embeddingUrl || vectorConfig.ollamaUrl || '';
const embeddingApiKey = process.env.EMBEDDING_API_KEY || vectorConfig.embeddingApiKey || '';
const embedModel = process.env.EMBED_MODEL || vectorConfig.embedModel;
const batchSize = Math.max(1, Math.min(Number(process.env.EMBEDDING_BATCH_SIZE || vectorConfig.embedBatchSize) || 32, 128));
const tokenBudget = Math.max(512, Number(process.env.EMBEDDING_TOKEN_BUDGET) || 24000);

function parseIds(value) {
    return [...new Set(String(value || '').split(/[,\s]+/).map(value => value.trim()).filter(Boolean))];
}

function estimatedTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function batches(items) {
    const result = [];
    let current = [];
    let tokens = 0;
    for (const item of items) {
        const itemTokens = estimatedTokens(item.text);
        if (current.length && (current.length >= batchSize || tokens + itemTokens > tokenBudget)) {
            result.push(current);
            current = [];
            tokens = 0;
        }
        current.push(item);
        tokens += itemTokens;
    }
    if (current.length) result.push(current);
    return result;
}

async function main() {
    if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('A positive EMBED_DIMENSIONS value is required');
    if (!embeddingUrl) throw new Error('An embedding URL is required');
    initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
    const database = getDatabase();
    const requestedUpserts = parseIds(process.env.LCR_VECTOR_IDS);
    const deleteIds = parseIds(process.env.LCR_VECTOR_DELETE_IDS);
    const stats = {
        total: requestedUpserts.length + deleteIds.length,
        processed: deleteIds.length,
        skipped: 0,
        skippedNoText: 0,
        skippedUnchanged: 0,
        cardUpdates: 0,
        chunkUpdates: 0,
        chunkDeletes: 0
    };
    const backend = new LanceSearchBackend({
        uri,
        vectorTableName: tableName,
        vectorConfig: { ...vectorConfig, enabled: true, embedDimensions: dimensions }
    });
    try {
        await backend.deleteVectorDocuments(deleteIds, { tableName });
        const rows = [];
        for (let offset = 0; offset < requestedUpserts.length; offset += 900) {
            const ids = requestedUpserts.slice(offset, offset + 900);
            const placeholders = ids.map(() => '?').join(', ');
            rows.push(...database.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...ids));
        }
        const foundIds = new Set(rows.map(row => String(row.id)));
        const missingCount = requestedUpserts.filter(id => !foundIds.has(id)).length;
        stats.processed += missingCount;
        stats.skipped += missingCount;
        stats.skippedNoText += missingCount;

        const items = rows.map(row => {
            const document = buildSearchDocumentFromRow(row);
            const normalized = normalizeLanceDocument(document);
            const text = normalized.searchText.slice(0, tokenBudget * 4);
            return { document, text };
        });

        for (const batch of batches(items)) {
            const usable = batch.filter(item => item.text.trim());
            const skipped = batch.length - usable.length;
            stats.processed += skipped;
            stats.skipped += skipped;
            stats.skippedNoText += skipped;
            if (!usable.length) continue;
            const vectors = await requestEmbeddings({
                provider: embeddingProvider,
                baseUrl: embeddingUrl,
                apiKey: embeddingApiKey,
                model: embedModel,
                texts: usable.map(item => item.text),
                dimensions,
                normalize: true,
                signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS) || 300000)
            });
            await backend.upsertVectorDocuments(usable.map((item, index) => ({ ...item, vector: vectors[index] })), {
                tableName,
                dimensions
            });
            stats.cardUpdates += usable.length;
            stats.processed += usable.length;
        }
    } finally {
        await backend.close();
    }
    console.log(`${VECTOR_RESULT_PREFIX}${JSON.stringify(stats)}`);
}

main().catch(error => {
    console.error('[LANCE:VECTOR] ETL failed:', error);
    process.exitCode = 1;
});
