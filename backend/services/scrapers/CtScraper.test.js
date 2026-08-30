import test from 'node:test';
import assert from 'node:assert/strict';

import { CtScraper } from './CtScraper.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test('Character Tavern detail bundle uses path detail and ID metadata endpoints', async () => {
    const requests = [];
    const httpClient = {
        async get(url) {
            requests.push(url);
            if (url.endsWith('/api/character/alice/test_card')) {
                return { data: { card: {
                    id: 'CT_remote_1', path: 'Alice/Test Card', name: 'Test', versionId: 7,
                    lastUpdatedAt: '2026-08-30T01:00:00.000Z', lorebookId: 44,
                    definition_character_description: 'Detailed description',
                    definition_first_message: 'Hello', tokenTotal: 12
                } } };
            }
            if (url.endsWith('/tags')) return { data: ['tag one', 'tag two'] };
            if (url.endsWith('/alternative-greetings')) return { data: ['Alternate hello'] };
            if (url.endsWith('/content-warnings')) return { data: { contentWarnings: ['violence'] } };
            if (url.endsWith('/lorebook')) return { data: { id: 44, scanDepth: 4, entries: [{ name: 'Fact', content: 'World fact', keys: ['world'] }] } };
            if (url.includes('ct-cards.storage.character-tavern.com')) return { data: PNG };
            throw new Error(`Unexpected URL ${url}`);
        }
    };
    const scraper = new CtScraper({ httpClient });

    const bundle = await scraper.fetchCardBundle({ id: 'CT_remote_1', path: 'Alice/Test Card' }, {});
    const metadata = await scraper.parseCardToMetadata(bundle, 91);

    assert.deepEqual(requests.slice(0, 5), [
        'https://character-tavern.com/api/character/alice/test_card',
        'https://character-tavern.com/api/character/CT_remote_1/tags',
        'https://character-tavern.com/api/character/CT_remote_1/alternative-greetings',
        'https://character-tavern.com/api/character/CT_remote_1/content-warnings',
        'https://character-tavern.com/api/character/CT_remote_1/lorebook'
    ]);
    assert.equal(metadata.sourcePath, 'alice/test_card');
    assert.equal(metadata.sourceId, 'CT_remote_1');
    assert.equal(metadata.sourceVersionId, 7);
    assert.equal(metadata.description, 'Detailed description');
    assert.equal(metadata.hasAlternateGreetings, true);
    assert.equal(metadata.hasLorebook, true);
    assert.deepEqual(metadata.topics, ['tag one', 'tag two']);
    assert.deepEqual(metadata.contentWarnings, ['violence']);
    assert.deepEqual(metadata.definition.data.character_book.entries[0].keys, ['world']);
});

test('Character Tavern image is required to have a PNG signature', async () => {
    const scraper = new CtScraper({
        httpClient: { async get() { return { data: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }; } },
        imageRetryDelays: []
    });

    await assert.rejects(() => scraper.fetchImage('alice/test_card'), /not a valid PNG/);
});

test('Character Tavern image requests PNG content and retries a transient CDN miss', async () => {
    let attempts = 0;
    const delays = [];
    const requestHeaders = [];
    const scraper = new CtScraper({
        httpClient: {
            async get(_url, options) {
                attempts += 1;
                requestHeaders.push(options.headers);
                if (attempts === 1) {
                    const error = new Error('not published');
                    error.response = { status: 404 };
                    throw error;
                }
                return { data: PNG, headers: { 'content-type': 'image/png' } };
            }
        },
        imageRetryDelays: [25],
        sleep: async delay => delays.push(delay)
    });

    assert.deepEqual(await scraper.fetchImage('alice/test_card'), PNG);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [25]);
    assert.equal(requestHeaders[0].accept, 'image/png');
});
