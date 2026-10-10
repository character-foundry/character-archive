import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import axios from 'axios';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import textChunk from 'png-chunk-text';
import sharp from 'sharp';
import { getCardFilePaths } from '../../utils/card-utils.js';
import { createConnection, closeConnection } from '../../db/connection.js';
import { ensureSchema } from '../../db/schema.js';
import { BaseScraper } from './BaseScraper.js';

import { CtScraper } from './CtScraper.js';
import { WyvernScraper } from './WyvernScraper.js';

// Controller imports load configuration; keep that initialization out of the user's workspace.
const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-archive-ct-test-'));
const previousConfigFile = process.env.CHARACTER_ARCHIVE_CONFIG_FILE;
process.env.CHARACTER_ARCHIVE_CONFIG_FILE = path.join(configDirectory, 'config.json');
fs.writeFileSync(process.env.CHARACTER_ARCHIVE_CONFIG_FILE, JSON.stringify({ port: 6969 }));
after(() => {
    if (previousConfigFile === undefined) delete process.env.CHARACTER_ARCHIVE_CONFIG_FILE;
    else process.env.CHARACTER_ARCHIVE_CONFIG_FILE = previousConfigFile;
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const AVATAR = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');

function readSillyTavernPng(png) {
    assert.ok(Buffer.isBuffer(png), 'The download must contain PNG bytes, not a JSON response');
    // Match SillyTavern/src/character-card-parser.js: tEXt only, case-insensitive
    // keys, ccv3 precedence, base64 -> UTF-8. Foundry also accepts raw JSON/zTXt.
    const chunks = extractChunks(new Uint8Array(png)); // Checks signature and chunk CRCs.
    const text = chunks.filter(chunk => chunk.name === 'tEXt').map(chunk => textChunk.decode(chunk.data));
    const selected = text.find(chunk => chunk.keyword.toLowerCase() === 'ccv3')
        || text.find(chunk => chunk.keyword.toLowerCase() === 'chara');
    assert.ok(selected, 'SillyTavern requires a chara or ccv3 tEXt chunk');
    assert.match(selected.text, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    const card = JSON.parse(Buffer.from(selected.text, 'base64').toString('utf8'));
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.spec_version, '2.0');
    assert.equal(typeof card.data.name, 'string');
    return card;
}

function setupCardUpdate(t, image = AVATAR) {
    const db = createConnection(':memory:');
    t.after(closeConnection);
    ensureSchema(db);
    db.prepare(`INSERT INTO cards (id, name, source, sourceId, sourcePath, lastModified, favorited)
        VALUES (91, 'Old metadata', 'ct', 'old-version', 'alice/test_card', '2099-01-01 00:00:00', 1)`).run();
    const requests = [];
    const writes = [];
    t.mock.method(axios, 'get', async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/api/character/alice/test_card')) return { data: { card: {
            id: 'new-version', path: 'alice/test_card', name: 'Updated card', versionId: 8,
            lastUpdatedAt: '2026-09-01T00:00:00Z', lorebookId: 44,
            definition_character_description: 'Complete character definition',
            definition_first_message: 'Hello from the updated card', tokenTotal: 12
        } } };
        if (url.endsWith('/tags')) return { data: ['test'] };
        if (url.endsWith('/alternative-greetings')) return { data: ['Another greeting'] };
        if (url.endsWith('/content-warnings')) return { data: { contentWarnings: [] } };
        if (url.endsWith('/lorebook')) return { data: { id: 44, entries: [{ content: 'World fact', keys: ['world'] }] } };
        if (url.includes('ct-cards.storage.character-tavern.com')) return { data: image };
        throw new Error(`Unexpected URL ${url}`);
    });
    t.mock.method(BaseScraper.prototype, 'writeCardFiles', async (dbId, files) => writes.push({ dbId, ...files }));
    return { db, requests, writes };
}

function assertImportableCard(writes) {
    assert.equal(writes.length, 1);
    assert.equal(writes[0].dbId, 91);
    // Parse only the downloadable PNG: the sidecar must not be needed to import it.
    const card = readSillyTavernPng(writes[0].png);
    assert.equal(card.data.description, 'Complete character definition');
    assert.equal(card.data.first_mes, 'Hello from the updated card');
    assert.deepEqual(card.data.alternate_greetings, ['Another greeting']);
    assert.equal(card.data.character_book.entries[0].content, 'World fact');
}

test('Character Tavern sync saves a PNG with an importable definition even for a plain CDN avatar', async t => {
    const { writes } = setupCardUpdate(t);
    const scraper = new CtScraper();
    const result = await scraper.processCard({ id: 'new-version', path: 'alice/test_card' }, { force: true });
    assert.equal(result.success, true, result.error);
    assertImportableCard(writes);
});

test('Character Tavern replaces stale embedded definitions while preserving image chunks', async t => {
    const chunks = extractChunks(AVATAR);
    const stale = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Stale', description: 'Outdated' } };
    const payload = Buffer.from(JSON.stringify(stale)).toString('base64');
    const asset = textChunk.encode('chara-ext-asset_:0', AVATAR.toString('base64'));
    chunks.splice(-1, 0,
        textChunk.encode('chara', payload), textChunk.encode('ccv3', payload),
        { name: 'zTXt', data: Buffer.concat([Buffer.from('CHARA\0\0'), deflateSync(payload)]) },
        { name: 'iTXt', data: Buffer.concat([Buffer.from('CCV3\0\0\0\0\0'), Buffer.from(payload)]) },
        textChunk.encode('Author', 'Original artist'), asset);
    const { writes } = setupCardUpdate(t, Buffer.from(encodeChunks(chunks)));
    const result = await new CtScraper().refreshCard(91);
    assert.equal(result.success, true);
    assertImportableCard(writes);
    const savedChunks = extractChunks(writes[0].png);
    const savedText = savedChunks.filter(chunk => chunk.name === 'tEXt').map(chunk => textChunk.decode(chunk.data));
    assert.equal(savedText.filter(chunk => chunk.keyword === 'chara').length, 1);
    assert.equal(savedText.some(chunk => chunk.keyword === 'ccv3'), false);
    assert.ok(savedText.some(chunk => chunk.keyword === 'chara-ext-asset_:0' && chunk.text === AVATAR.toString('base64')));
    assert.ok(savedText.some(chunk => chunk.keyword === 'Author' && chunk.text === 'Original artist'));
    assert.deepEqual(savedChunks.filter(chunk => chunk.name !== 'tEXt'), extractChunks(AVATAR));
});

test('Character Tavern rejects a corrupt download without replacing cached card files or metadata', async t => {
    const { db, writes } = setupCardUpdate(t, PNG);
    await assert.rejects(() => new CtScraper().refreshCard(91), /Failed to refresh:/);
    assert.equal(writes.length, 0);
    assert.equal(db.prepare('SELECT sourceId FROM cards WHERE id = 91').get().sourceId, 'old-version');
});

test('CT repair removes mixed-case stale metadata that SillyTavern would prefer', async t => {
    const chunks = extractChunks(AVATAR);
    chunks.splice(-1, 0, textChunk.encode('CCv3', Buffer.from('stale invalid JSON').toString('base64')));
    const { writes } = setupCardUpdate(t, Buffer.from(encodeChunks(chunks)));
    await new CtScraper().refreshCard(91);
    assertImportableCard(writes);
});

for (const format of ['png', 'jpeg', 'webp']) {
    test(`Wyvern sync embeds its definition in a real PNG when the proxy returns ${format}`, async t => {
        const { db, writes } = setupCardUpdate(t);
        db.prepare("UPDATE cards SET source = 'wyvern', sourceId = 'wyvern-test' WHERE id = 91").run();
        const image = await sharp(AVATAR).toFormat(format).toBuffer();
        const scraper = new WyvernScraper();
        t.mock.method(scraper, 'fetchCard', async () => ({ data: {
            id: 'wyvern-test', name: '雪 ❄', avatar: 'https://app.wyvern.chat/avatar',
            description: 'Complete character definition', first_mes: 'Hello from the updated card',
            alternate_greetings: ['Another greeting'],
            lorebooks: [{ entries: [{ content: 'World fact', keys: ['world'] }] }]
        } }));
        t.mock.method(axios, 'get', async () => ({ data: { image: `data:image/${format};base64,${image.toString('base64')}` } }));
        const result = await scraper.processCard({ id: 'wyvern-test' }, { force: true });
        assert.equal(result.success, true, result.error);
        assertImportableCard(writes);
        assert.equal(readSillyTavernPng(writes[0].png).data.name, '雪 ❄');
        assert.deepEqual(await sharp(writes[0].png).raw().toBuffer(), await sharp(image).raw().toBuffer());
    });
}

for (const source of ['ct', 'wyvern']) {
    for (const useLocal of [false, true]) {
        test(`${source} PNG export returns image bytes and embeds ${useLocal ? 'cached' : 'original'} asset URLs`, async t => {
            const { db } = setupCardUpdate(t);
            db.prepare('UPDATE cards SET source = ? WHERE id = 91').run(source);
            const remoteUrl = 'https://files.catbox.moe/scene.png';
            const localPath = 'cached-assets/91/scene.png';
            db.prepare('INSERT INTO cached_assets (cardId, originalUrl, localPath, assetType) VALUES (91, ?, ?, ?)')
                .run(remoteUrl, localPath, 'image');
            const definition = {
                spec: 'chara_card_v2', spec_version: '2.0', data: {
                    name: '雪 ❄', description: `![scene](${remoteUrl})`, first_mes: 'Hello',
                    alternate_greetings: [`Look: ${remoteUrl}`],
                    character_book: { entries: [{ keys: ['scene'], content: remoteUrl }] }
                }
            };
            const metadata = JSON.stringify({ source, definition });
            // Older Wyvern cache files can contain JPEG bytes under a .png filename.
            const image = source === 'wyvern' ? await sharp(AVATAR).jpeg().toBuffer() : AVATAR;
            const { pngPath, jsonPath } = getCardFilePaths(91);
            const exists = fs.existsSync;
            const read = fs.readFileSync;
            t.mock.method(fs, 'existsSync', file => [pngPath, jsonPath].includes(file) || exists(file));
            t.mock.method(fs, 'readFileSync', (file, ...args) => file === pngPath ? image : file === jsonPath ? metadata : read(file, ...args));
            const { cardController } = await import('../../controllers/CardController.js');
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                type(value) { this.contentType = value; return this; },
                attachment(value) { this.filename = value; return this; },
                send(body) { this.body = body; return this; },
                json(body) { this.body = body; return this; }
            };
            await cardController.exportCard({ params: { cardId: '91' }, query: { format: 'png', useLocal: String(useLocal) } }, res);
            assert.equal(res.statusCode, 200, res.body?.error);
            const card = readSillyTavernPng(res.body);
            assert.equal(res.contentType, 'image/png');
            assert.equal(res.filename, '91.png');
            const expectedUrl = useLocal ? `/static/${localPath}` : remoteUrl;
            assert.equal(card.data.description, `![scene](${expectedUrl})`);
            assert.deepEqual(card.data.alternate_greetings, [`Look: ${expectedUrl}`]);
            assert.equal(card.data.character_book.entries[0].content, expectedUrl);
            assert.equal(card.data.name, '雪 ❄');
            assert.deepEqual(await sharp(res.body).raw().toBuffer(), await sharp(image).raw().toBuffer());
        });
    }
}

test('Wyvern rejects malformed image bytes before replacing the stored files or metadata', async t => {
    const { db, writes } = setupCardUpdate(t);
    db.prepare("UPDATE cards SET source = 'wyvern', sourceId = 'wyvern-test' WHERE id = 91").run();
    const scraper = new WyvernScraper();
    t.mock.method(scraper, 'fetchCard', async () => ({ data: {
        id: 'wyvern-test', name: 'New metadata', avatar: 'https://app.wyvern.chat/avatar'
    } }));
    t.mock.method(axios, 'get', async () => ({ data: { image: `data:image/png;base64,${PNG.toString('base64')}` } }));
    const result = await scraper.processCard({ id: 'wyvern-test' }, { force: true });
    assert.equal(result.success, false);
    assert.equal(writes.length, 0);
    assert.equal(db.prepare('SELECT name FROM cards WHERE id = 91').get().name, 'Old metadata');
});

test('Character Tavern refresh rejects a missing source path before making requests', async t => {
    const { db, requests, writes } = setupCardUpdate(t);
    db.prepare('UPDATE cards SET sourcePath = NULL WHERE id = 91').run();
    await assert.rejects(() => new CtScraper().refreshCard(91), /no valid author\/slug path/);
    assert.equal(requests.length, 0);
    assert.equal(writes.length, 0);
});

test('Character Tavern refresh reports upstream errors without replacing cached cards', async t => {
    const { writes } = setupCardUpdate(t);
    t.mock.method(axios, 'get', async () => { throw new Error('Request failed with status code 403'); });
    const { cardController } = await import('../../controllers/CardController.js');
    const res = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    await cardController.refreshCard({ params: { cardId: '91' } }, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /403/);
    assert.equal(writes.length, 0);
});

test('Character Tavern manual refresh uses its saved path and forces a complete update', async t => {
    const { db, requests, writes } = setupCardUpdate(t);
    const { cardController } = await import('../../controllers/CardController.js');
    const { appConfig } = await import('../ConfigState.js');
    const previous = appConfig.ctSync;
    appConfig.ctSync = { enabled: false, cookies: ['cf_clearance=fixture'], minTokens: 1000 };
    t.after(() => { appConfig.ctSync = previous; });
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await cardController.refreshCard({ params: { cardId: '91' } }, res);

    assert.equal(res.statusCode, 200, res.body?.error);
    assert.equal(res.body.success, true);
    assertImportableCard(writes);
    assert.ok(requests.every(({ options }) => options.headers.Cookie === 'cf_clearance=fixture'));
    const saved = db.prepare('SELECT sourceId, favorited FROM cards WHERE id = 91').get();
    assert.equal(saved.sourceId, 'new-version');
    assert.equal(saved.favorited, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 1);
});

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
