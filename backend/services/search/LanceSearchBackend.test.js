import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LanceSearchBackend } from './LanceSearchBackend.js';

function document(overrides) {
    return {
        id: '1',
        name: 'Aster',
        tagline: '',
        description: '',
        platform_summary: '',
        author: 'author',
        source: 'chub',
        sourceId: 'source-1',
        sourcePath: '',
        sourceSpecific: '',
        fullPath: '',
        tags: [],
        topics: [],
        type: 'character',
        language: 'en',
        visibility: 'public',
        favorited: 0,
        hasAlternateGreetings: false,
        hasLorebook: false,
        hasEmbeddedLorebook: false,
        hasLinkedLorebook: false,
        hasExampleDialogues: false,
        hasSystemPrompt: false,
        hasGallery: false,
        hasEmbeddedImages: false,
        hasExpressions: false,
        tokenCount: 0,
        token_count: 0,
        rating: 0,
        ratingCount: 0,
        starCount: 0,
        n_favorites: 0,
        favorites: 0,
        nChats: 0,
        nMessages: 0,
        tokenDescriptionCount: 0,
        tokenPersonalityCount: 0,
        tokenScenarioCount: 0,
        tokenMesExampleCount: 0,
        tokenFirstMessageCount: 0,
        tokenSystemPromptCount: 0,
        tokenPostHistoryCount: 0,
        created: '2026-01-01',
        createdAt: '2026-01-01',
        added: '2026-01-01',
        updated: '2026-01-01',
        lastModified: '2026-01-01',
        scoreComposite: 0,
        scoreVelocity: 0,
        engagementScore: 0,
        engagementVelocity: 0,
        ...overrides
    };
}

test('LanceDB preserves lexical search, filters, sorting, and durable updates', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'character-archive-lance-'));
    t.after(async () => rm(directory, { recursive: true, force: true }));
    const backend = new LanceSearchBackend({ uri: directory, tableName: 'cards_test' });

    await backend.rebuild([
        document({ id: '1', name: 'Wizard of Ash', description: 'ancient fire mage', tags: ['fantasy'], source: 'ct', tokenCount: 900 }),
        document({ id: '2', name: 'Star Pilot', description: 'spaceship captain', tags: ['sci-fi'], source: 'chub', tokenCount: 1800 }),
        document({ id: '3', name: 'Forest Wizard', description: 'gentle druid mage', tags: ['fantasy'], source: 'ct', tokenCount: 2400 })
    ]);

    const lexical = await backend.searchLexical({
        text: 'wizard',
        filter: 'source = "ct" AND tags = "fantasy"',
        page: 1,
        limit: 10,
        sort: null
    });
    assert.deepEqual(new Set(lexical.ids), new Set(['1', '3']));
    assert.equal(lexical.total, 2);
    assert.match(lexical.appliedFilter, /array_contains/);

    const filtered = await backend.searchLexical({
        filter: 'tokenCount >= 1000',
        page: 1,
        limit: 10,
        sort: 'tokens_desc'
    });
    assert.deepEqual(filtered.ids, ['3', '2']);
    assert.equal(filtered.total, 2);

    await backend.upsertDocuments([document({ id: '2', name: 'Star Pilot', tokenCount: 2600, source: 'chub' })]);
    await backend.upsertDocuments([document({ id: '4', name: 'Moon Witch', description: 'lunar spellcaster', tokenCount: 800 })]);
    await backend.deleteDocumentsByIds(['1']);
    const updated = await backend.searchLexical({ filter: 'tokenCount >= 1000', limit: 10, sort: 'tokens_desc' });
    assert.deepEqual(updated.ids, ['2', '3']);
    const incrementalText = await backend.searchLexical({ text: 'witch', limit: 10, sort: null });
    assert.deepEqual(incrementalText.ids, ['4']);
    assert.equal(await backend.countRows(), 3);

    await backend.close();
});

test('LanceDB rebuild swaps an indexed shadow table only after the build succeeds', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'character-archive-lance-swap-'));
    t.after(async () => rm(directory, { recursive: true, force: true }));
    const backend = new LanceSearchBackend({ uri: directory, tableName: 'cards_test', batchSize: 1 });

    await backend.rebuild([document({ id: '1', name: 'Original Wizard' })]);
    const initialTableName = backend.activeTableName;
    const originalCreateIndexes = backend.createIndexes.bind(backend);
    backend.createIndexes = async () => {
        throw new Error('simulated index failure');
    };

    await assert.rejects(
        backend.rebuild([document({ id: '2', name: 'Replacement Pilot' })]),
        /simulated index failure/
    );
    assert.equal(backend.activeTableName, initialTableName);
    assert.deepEqual((await backend.searchLexical({ text: 'wizard', sort: null })).ids, ['1']);
    assert.deepEqual((await backend.searchLexical({ text: 'pilot', sort: null })).ids, []);

    backend.createIndexes = originalCreateIndexes;
    await backend.rebuildBatches((async function* () {
        yield [document({ id: '2', name: 'Replacement Pilot' })];
        yield [document({ id: '3', name: 'Second Pilot' })];
    })());
    assert.notEqual(backend.activeTableName, initialTableName);
    assert.deepEqual(new Set((await backend.searchLexical({ text: 'pilot', sort: null })).ids), new Set(['2', '3']));
    assert.deepEqual((await backend.searchLexical({ text: 'wizard', sort: null })).ids, []);

    await backend.close();
});

test('LanceDB vector search uses the same filters and response contract', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'character-archive-lance-vector-'));
    t.after(async () => rm(directory, { recursive: true, force: true }));
    const backend = new LanceSearchBackend({
        uri: directory,
        tableName: 'cards_test',
        vectorTableName: 'vectors_test',
        vectorConfig: {
            enabled: true,
            embedModel: 'test-model',
            embedDimensions: 3,
            embeddingProvider: 'openai',
            embeddingUrl: 'http://unused'
        },
        embeddingRequest: async () => [[1, 0, 0]]
    });
    await backend.upsertVectorDocuments([
        { document: document({ id: '1', name: 'Fire Mage', source: 'ct', tags: ['fantasy'] }), vector: [1, 0, 0], text: 'fire mage' },
        { document: document({ id: '2', name: 'Pilot', source: 'chub', tags: ['sci-fi'] }), vector: [0, 1, 0], text: 'space pilot' },
        { document: document({ id: '3', name: 'Druid', source: 'ct', tags: ['fantasy'] }), vector: [0.8, 0.2, 0], text: 'forest druid' }
    ]);

    const result = await backend.searchVector({
        text: 'magic',
        filter: 'source = "ct" AND tags = "fantasy"',
        page: 1,
        limit: 10
    });
    assert.deepEqual(result.ids, ['1', '3']);
    assert.equal(result.total, 2);
    assert.equal(result.chunkMatches['1'].text, 'fire mage');
    assert.ok(result.scores['1'] > result.scores['3']);
    assert.equal(result.meta.provider, 'lancedb');

    await backend.deleteVectorDocuments(['1']);
    const afterDelete = await backend.searchVector({ text: 'magic', limit: 10 });
    assert.deepEqual(new Set(afterDelete.ids), new Set(['2', '3']));
    await backend.close();
});
