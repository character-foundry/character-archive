import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { createConnection, closeConnection } from '../db/connection.js';
import { ensureSchema } from '../db/schema.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-favorites-'));
process.env.CHARACTER_ARCHIVE_CONFIG_FILE = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CHARACTER_ARCHIVE_CONFIG_FILE, '{}');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { appConfig } = await import('./ConfigState.js');
const { readFavorite, saveFavorite, linkArchitectCard, reconcileFavorites } = await import('./FavoriteSyncService.js');
const { cardController } = await import('../controllers/CardController.js');
const { pushDirect } = await import('./DirectConnectionsService.js');

function setup(t) {
    const db = createConnection(':memory:');
    ensureSchema(db);
    db.prepare("INSERT INTO cards (id, name, source, favorited) VALUES (91, 'Test', 'chub', 0)").run();
    t.after(closeConnection);
    t.mock.method(fs, 'existsSync', () => false);
    appConfig.characterArchitect = { url: 'http://architect:3456' };
    appConfig.syncFavoritesToChub = false;
    return db;
}

test('local favorite succeeds with a Chub key present and makes no Chub request', async t => {
    const db = setup(t);
    appConfig.chubApiKey = 'test-key';
    const remote = t.mock.method(axios, 'request', async () => { throw new Error('must not call Chub'); });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await cardController.toggleFavorite({ params: { cardId: '91' } }, res);
    await reconcileFavorites();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.favorited, 1);
    assert.equal(db.prepare('SELECT favorited FROM cards WHERE id=91').get().favorited, 1);
    assert.equal(remote.mock.callCount(), 0);
});

test('linked favorites converge both ways, including offline unstars and retries', async t => {
    const db = setup(t);
    await linkArchitectCard(91, appConfig.characterArchitect.url, 'remote-91');
    let remote = { favorite: false, updatedAt: 0, changeId: '' };
    let offline = false;
    const send = t.mock.method(axios, 'post', async (_url, { cards }) => {
        if (offline) throw new Error('offline');
        const local = cards[0].state;
        if (local.updatedAt > remote.updatedAt) remote = local;
        return { data: { cards: [{ cardId: 'remote-91', state: { ...remote } }] } };
    });
    await saveFavorite(91, true);
    await reconcileFavorites();
    assert.equal(remote.favorite, true);
    remote = { favorite: false, updatedAt: remote.updatedAt + 1, changeId: 'remote-change' };
    await reconcileFavorites();
    assert.equal(readFavorite(91).favorite, false);
    assert.equal(db.prepare('SELECT favorited FROM cards WHERE id=91').get().favorited, 0);
    await saveFavorite(91, true);
    offline = true;
    await reconcileFavorites();
    assert.equal(readFavorite(91).favorite, true);
    offline = false;
    await reconcileFavorites();
    assert.deepEqual(remote, readFavorite(91));
    const count = send.mock.callCount();
    await reconcileFavorites();
    assert.equal(send.mock.callCount(), count + 1, 'One bounded exchange; no echo loop');
    assert.deepEqual(remote, readFavorite(91));
});

test('an in-flight remote response cannot overwrite a newer local click', async t => {
    setup(t);
    await linkArchitectCard(91, appConfig.characterArchitect.url, 'remote-91');
    const old = readFavorite(91);
    let resolveGet;
    t.mock.method(axios, 'post', () => new Promise(resolve => { resolveGet = resolve; }));
    const syncing = reconcileFavorites();
    await saveFavorite(91, true);
    resolveGet({ data: { cards: [{ cardId: 'remote-91', state: old }] } });
    await syncing;
    assert.equal(readFavorite(91).favorite, true);

});

test('starring an unlinked card uploads it once and synchronizes its star', async t => {
    const db = setup(t);
    t.mock.method(fs, 'existsSync', name => String(name).endsWith('.png'));
    t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
    let uploads = 0;
    let remoteState;
    t.mock.method(axios, 'post', async (url, body) => {
        if (url.endsWith('/import')) {
            uploads++;
            return { data: { card: { meta: { id: 'auto-91' } } } };
        }
        remoteState = body.cards[0].state;
        return { data: { cards: body.cards } };
    });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await cardController.toggleFavorite({ params: { cardId: '91' } }, res);
    await reconcileFavorites();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.favorited, 1);
    assert.equal(uploads, 1);
    assert.equal(remoteState.favorite, true);
    assert.equal(db.prepare('SELECT remote_id FROM architect_links WHERE card_id=91').get().remote_id, 'auto-91');
    await pushDirect(91, 'architect');
    await reconcileFavorites();
    assert.equal(uploads, 1, 'Sending or polling an already linked card must not make duplicates');
});

test('offline favorites persist, retry later, and use an unstar made during upload', async t => {
    const db = setup(t);
    t.mock.method(fs, 'existsSync', name => String(name).endsWith('.png'));
    t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
    let offline = true;
    let uploads = 0;
    let remoteState;
    t.mock.method(axios, 'post', async (url, body) => {
        if (url.endsWith('/import')) {
            uploads++;
            if (offline) throw new Error('offline');
            await saveFavorite(91, false);
            return { data: { card: { meta: { id: 'auto-91' } } } };
        }
        remoteState = body.cards[0].state;
        return { data: { cards: body.cards } };
    });
    await saveFavorite(91, true);
    await reconcileFavorites();
    assert.equal(readFavorite(91).favorite, true);
    assert.equal(uploads, 1);
    await reconcileFavorites();
    assert.equal(uploads, 1, 'A failed upload backs off instead of repeating on every click');
    db.prepare('UPDATE architect_export_retries SET next_attempt_at=0').run();
    offline = false;
    await reconcileFavorites();
    assert.equal(uploads, 2);
    assert.equal(remoteState.favorite, false);
    assert.equal(readFavorite(91).favorite, false);
});

test('unstarred cards and disabled Architect connections do not trigger uploads', async t => {
    setup(t);
    const post = t.mock.method(axios, 'post', async () => { throw new Error('unexpected upload'); });
    await saveFavorite(91, true);
    await saveFavorite(91, false);
    await reconcileFavorites();
    await saveFavorite(91, true);
    appConfig.characterArchitect.enabled = false;
    await reconcileFavorites();
    assert.equal(post.mock.callCount(), 0);
});

test('a slow automatic upload does not delay saving the star or duplicate a manual send', async t => {
    setup(t);
    t.mock.method(fs, 'existsSync', name => String(name).endsWith('.png'));
    t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
    let finishUpload;
    let started;
    const uploadStarted = new Promise(resolve => { started = resolve; });
    let uploads = 0;
    t.mock.method(axios, 'post', async (url, body) => {
        if (!url.endsWith('/import')) return { data: { cards: body.cards } };
        uploads++;
        started();
        return new Promise(resolve => { finishUpload = resolve; });
    });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await cardController.toggleFavorite({ params: { cardId: '91' } }, res);
    assert.equal(res.body.favorited, 1, 'The local HTTP response is ready while the upload is pending');
    await uploadStarted;
    const manual = pushDirect(91, 'architect');
    finishUpload({ data: { card: { meta: { id: 'auto-91' } } } });
    assert.equal((await manual).remoteId, 'auto-91');
    await reconcileFavorites();
    assert.equal(uploads, 1);
});
