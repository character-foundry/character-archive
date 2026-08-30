import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('advanced card search keeps its public contract when LanceDB is selected', async () => {
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
                (2, 'Star Pilot', 'spaceship captain', 'sci-fi', 'chub', 2200, '2026-08-02')
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
