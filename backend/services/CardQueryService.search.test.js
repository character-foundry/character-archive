import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LanceSearchBackend } from './search/LanceSearchBackend.js';

test('advanced card search keeps its public contract when LanceDB is selected', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-archive-search-contract-'));
    process.env.CHARACTER_ARCHIVE_DB_FILE = path.join(directory, 'cards.db');
    process.env.CHARACTER_ARCHIVE_CONFIG_FILE = path.join(directory, 'config.json');
    process.env.SEARCH_LANCE_PATH = path.join(directory, 'lance');
    fs.writeFileSync(process.env.CHARACTER_ARCHIVE_CONFIG_FILE, JSON.stringify({ port: 6969 }));

    const databaseModule = await import('../database.js');
    const { closeConnection } = await import('../db/connection.js');
    const search = await import('./SearchService.js');
    const { appConfig } = await import('./ConfigState.js');
    const { parseListParams, performAdvancedSearch, buildResponse } = await import('./CardQueryService.js');
    try {
        search.configureSearchBackend({
            meilisearch: { enabled: true, host: 'http://127.0.0.1:7700', apiKey: '', indexName: 'cards' },
            vectorSearch: { enabled: false }
        });
        assert.equal(search.getSearchProvider(), 'meilisearch', 'legacy configs keep their Meilisearch provider');
        const database = databaseModule.initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
        database.prepare(`
            INSERT INTO cards (id, name, description, topics, source, tokenCount, lastModified)
            VALUES
                (1, 'Ash Wizard', 'ancient fire mage', 'fantasy,magic', 'ct', 1500, '2026-08-01'),
                (2, 'Star Pilot', 'spaceship captain', 'sci-fi', 'chub', 2200, '2026-08-02'),
                (3, 'Heroes Party', '', 'fantasy', 'chub', 900, '2025-01-01'),
                (4, 'Newest Dispatch', 'heroes party appears once among many unrelated dispatch words and background details', 'news', 'chub', 900, '2026-08-31')
        `).run();
        const config = {
            ...appConfig,
            search: { enabled: true, backend: 'lancedb', lancedb: { uri: process.env.SEARCH_LANCE_PATH, tableName: 'cards' } },
            meilisearch: { enabled: false, host: '', apiKey: '', indexName: 'cards' },
            vectorSearch: { ...(appConfig.vectorSearch || {}), enabled: false }
        };
        Object.assign(appConfig, config);
        search.configureSearchBackend(config);
        await assert.rejects(
            search.assertSearchBackendReady(config),
            /not built and activated/
        );
        await search.rebuildSearchIndexFromRows(database.prepare('SELECT * FROM cards').all());
        await search.assertSearchBackendReady(config);

        const params = parseListParams({
            advanced: 'true',
            query: 'wizard',
            include: 'fantasy',
            source: 'ct',
            limit: '20'
        });
        const result = await performAdvancedSearch(params);
        assert.equal(result.success, true);
        assert.equal(result.mode, 'lexical');
        assert.equal(result.total, 1);
        assert.deepEqual(result.cards.map(card => String(card.id)), ['1']);

        const textExpression = await performAdvancedSearch(parseListParams({
            advanced: 'true',
            advancedFilter: 'wizard',
            limit: '20'
        }));
        assert.equal(textExpression.mode, 'lexical');
        assert.deepEqual(textExpression.cards.map(card => String(card.id)), ['1']);
        assert.equal(textExpression.appliedFilter, '');

        const listedFilter = await performAdvancedSearch(parseListParams({
            advanced: 'true',
            advancedFilter: 'source IN ["ct", "chub"] AND tokenCount >= 2000',
            limit: '20'
        }));
        assert.equal(listedFilter.mode, 'lexical');
        assert.deepEqual(listedFilter.cards.map(card => String(card.id)), ['2']);

        const invalidFilter = await performAdvancedSearch(parseListParams({
            advanced: 'true',
            query: 'wizard',
            advancedFilter: 'tokenCount >'
        }));
        assert.equal(invalidFilter.fallback, true);
        assert.equal(invalidFilter.filterError, true);
        assert.match(invalidFilter.fallbackReason, /Invalid advanced filter/);

        const titleMatch = await performAdvancedSearch(parseListParams({
            advanced: 'true',
            query: 'heroes party',
            sort: 'new',
            limit: '20'
        }));
        assert.equal(titleMatch.mode, 'lexical');
        assert.equal(String(titleMatch.cards[0].id), '3');

        const embeddingServer = http.createServer(async (request, response) => {
            for await (const _chunk of request) { /* consume the request body */ }
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
        });
        await new Promise(resolve => embeddingServer.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => embeddingServer.close(resolve)));
        const embeddingUrl = `http://127.0.0.1:${embeddingServer.address().port}`;
        const vectorConfig = {
            ...(config.vectorSearch || {}),
            enabled: true,
            cardsIndex: 'vectors_test',
            embedModel: 'test-model',
            embedderName: 'test',
            embedDimensions: 3,
            embeddingProvider: 'openai',
            embeddingUrl,
            semanticRatio: 0.4,
            maxCardHits: 400
        };
        const vectorBackend = new LanceSearchBackend({
            uri: process.env.SEARCH_LANCE_PATH,
            vectorTableName: vectorConfig.cardsIndex,
            vectorConfig
        });
        await vectorBackend.upsertVectorDocuments(
            database.prepare('SELECT * FROM cards ORDER BY id').all().map(row => ({
                document: { ...row, id: String(row.id) },
                text: row.description || row.name,
                vector: row.id === 3 ? [1, 0, 0] : [0, 1, 0]
            })),
            { tableName: vectorConfig.cardsIndex, dimensions: 3 }
        );
        await vectorBackend.close();
        const hybridConfig = { ...config, vectorSearch: vectorConfig };
        Object.assign(appConfig, hybridConfig);
        search.configureSearchBackend(hybridConfig);
        for (let attempts = 0; attempts < 20 && !search.isVectorSearchReady(); attempts += 1) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(search.isVectorSearchReady(), true);

        const hybrid = await performAdvancedSearch(parseListParams({ advanced: 'true', query: 'heroes party' }));
        assert.equal(hybrid.mode, 'vector');
        assert.equal(String(hybrid.cards[0].id), '3');
        const phrase = await performAdvancedSearch(parseListParams({ advanced: 'true', query: '"heroes party"' }));
        assert.equal(phrase.mode, 'lexical');
        const boolean = await performAdvancedSearch(parseListParams({ advanced: 'true', query: 'heroes AND party' }));
        assert.equal(boolean.mode, 'lexical');

        const response = await buildResponse(result.cards, result.total, params, {
            enabled: true,
            mode: result.mode,
            query: params.query,
            filter: result.appliedFilter
        });
        assert.equal(response.count, 1);
        assert.equal(response.totalPages, 1);
        assert.equal(response.advanced.mode, 'lexical');
    } finally {
        await search.closeSearchBackend();
        closeConnection();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
