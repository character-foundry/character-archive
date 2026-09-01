#!/usr/bin/env node

import { closeConnection } from '../backend/db/connection.js';
import { initDatabase } from '../backend/database.js';
import { getVectorGenerationRepository } from '../backend/db/repositories/VectorGenerationRepository.js';
import { LanceSearchBackend } from '../backend/services/search/LanceSearchBackend.js';
import { loadConfig } from '../config-loader.js';

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

const generationId = Number(argument('--generation'));
if (!Number.isInteger(generationId) || generationId <= 0) {
    throw new Error('Usage: node scripts/reconcile-lance-generation.js --generation ID');
}

initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const repository = getVectorGenerationRepository();
const generation = repository.get(generationId);
if (!generation) throw new Error(`Vector generation ${generationId} was not found`);
if (!String(generation.embedder_name || '').startsWith('lance-')) {
    throw new Error(`Vector generation ${generationId} is not a LanceDB generation`);
}

const config = loadConfig();
const backend = new LanceSearchBackend({
    uri: process.env.SEARCH_LANCE_PATH || config.search?.lancedb?.uri,
    vectorTableName: generation.cards_index,
    vectorConfig: {
        ...(config.vectorSearch || {}),
        enabled: true,
        embedDimensions: generation.dimensions
    }
});

try {
    const table = await backend.openVectorTable({ tableName: generation.cards_index });
    const rowCount = await table.countRows();
    const pageSize = 10_000;
    let reconciled = 0;
    for (let offset = 0; offset < rowCount; offset += pageSize) {
        const rows = await table.query()
            .select(['card_id'])
            .offset(offset)
            .limit(pageSize)
            .toArray();
        reconciled += repository.reconcileSnapshotCardIds(
            generationId,
            rows.map(row => String(row.card_id))
        );
    }
    const result = repository.refreshProgress(generationId);
    if (result.status === 'ready') {
        await backend.ensureVectorIndex({ tableName: generation.cards_index });
    }
    process.stdout.write(`${JSON.stringify({
        generationId,
        table: generation.cards_index,
        tableRows: rowCount,
        reconciled,
        status: result.status,
        expectedCards: result.expected_cards,
        indexedCards: result.indexed_cards,
        queuedItems: result.queued_items,
        retryItems: result.retry_items,
        deadItems: result.dead_items
    }, null, 2)}\n`);
} finally {
    await backend.close();
    closeConnection();
}
