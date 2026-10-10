import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { createConnection, closeConnection } from '../db/connection.js';
import { ensureSchema } from '../db/schema.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-connections-'));
process.env.CHARACTER_ARCHIVE_CONFIG_FILE = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CHARACTER_ARCHIVE_CONFIG_FILE, '{}');
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const { appConfig } = await import('./ConfigState.js');
const { reconcileFavorites } = await import('./FavoriteSyncService.js');
const { cardController } = await import('../controllers/CardController.js');

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('Archive sends PNG bytes to Architect without asking Architect to fetch a private URL', async t => {
  const db = createConnection(':memory:');
  ensureSchema(db);
  t.after(closeConnection);
  db.prepare("INSERT INTO cards (id, name, source) VALUES (91, 'Test', 'chub')").run();
  appConfig.characterArchitect = { url: 'http://127.0.0.1:3456' };
  t.mock.method(fs, 'existsSync', name => name.endsWith('.png'));
  t.mock.method(axios, 'get', async () => ({ data: { favorite: false, updatedAt: 0, changeId: '' } }));
  t.mock.method(axios, 'put', async (_url, state) => ({ data: state }));
  t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
  t.mock.method(axios, 'post', async (url, body) => {
    if (url.endsWith('/favorites/sync')) return { data: { cards: body.cards } };
    assert.equal(url, 'http://127.0.0.1:3456/api/import');
    assert.equal(typeof body.getHeaders, 'function');
    return { status: 201, data: { card: { meta: { id: 'remote-91' } } } };
  });
  const res = response();
  await cardController.pushToArchitect({ params: { cardId: '91' }, protocol: 'http', get: () => 'archive:6969' }, res);
  await reconcileFavorites();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
});

test('Archive uploads to Lumiverse with session credentials and validates its response', async t => {
  const db = createConnection(':memory:');
  ensureSchema(db);
  t.after(closeConnection);
  db.prepare("INSERT INTO cards (id, name, source) VALUES (92, 'Lumi Test', 'chub')").run();
  appConfig.lumiverse = { enabled: true, baseUrl: 'http://lumiverse:7860/app/api/', sessionCookie: 'session=test' };
  t.mock.method(fs, 'existsSync', name => name.endsWith('.png'));
  t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
  t.mock.method(axios, 'post', async (url, body, options) => {
    assert.equal(url, 'http://lumiverse:7860/app/api/characters/import');
    assert.equal(options.headers.Cookie, 'session=test');
    assert.equal(options.maxRedirects, 0);
    assert.ok(body.getBuffer().includes(Buffer.from('name="file"')));
    return { data: { character: { id: 'lumi-92' } } };
  });
  const res = response();
  await cardController.pushToLumiverse({ params: { cardId: '92' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.remoteId, 'lumi-92');
});

test('Archive reports an expired Lumiverse session instead of claiming success', async t => {
  const db = createConnection(':memory:');
  ensureSchema(db);
  t.after(closeConnection);
  db.prepare("INSERT INTO cards (id, name, source) VALUES (92, 'Lumi Test', 'chub')").run();
  appConfig.lumiverse = { enabled: true, baseUrl: 'http://lumiverse:7860' };
  t.mock.method(fs, 'existsSync', name => name.endsWith('.png'));
  t.mock.method(fs, 'readFileSync', () => Buffer.from('PNG fixture'));
  t.mock.method(axios, 'post', async () => { throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } }); });
  const res = response();
  await cardController.pushToLumiverse({ params: { cardId: '92' } }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /session expired/i);
});
