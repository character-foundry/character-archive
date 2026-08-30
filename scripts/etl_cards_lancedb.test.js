import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

import { ensureSchema } from '../backend/db/schema.js';
import { parseVectorEtlResult, validateVectorEtlResult } from './vector-etl-contract.js';

const execFileAsync = promisify(execFile);

test('Lance vector ETL batches embeddings and fulfills the durable worker contract', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-lance-etl-'));
    const databasePath = path.join(directory, 'cards.db');
    const configPath = path.join(directory, 'config.json');
    const lancePath = path.join(directory, 'lance');
    const database = new Database(databasePath);
    ensureSchema(database);
    const boundaryName = 'Boundary Card';
    const boundaryDescription = `${'a'.repeat(31_999 - boundaryName.length - 1)}𝚁 trailing text`;
    database.prepare(`
        INSERT INTO cards (id, name, description, topics, source)
        VALUES (1, 'Fire Mage', 'ancient fire magic', 'fantasy', 'ct'),
               (2, 'Star Pilot', 'deep space captain', 'sci-fi', 'chub'),
               (3, ?, ?, 'unicode', 'ct')
    `).run(boundaryName, boundaryDescription);
    database.close();
    fs.writeFileSync(configPath, JSON.stringify({
        port: 6969,
        search: { enabled: true, backend: 'lancedb', lancedb: { uri: lancePath, tableName: 'cards' } },
        vectorSearch: {
            enabled: true,
            cardsIndex: 'test_vectors',
            embedModel: 'test-model',
            embedderName: 'test',
            embedDimensions: 3,
            embeddingProvider: 'openai',
            embeddingUrl: ''
        }
    }));

    const server = http.createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const hasUnpairedSurrogate = body.input.some(value => /[\uD800-\uDFFF]/u.test(value));
        if (hasUnpairedSurrogate) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'unpaired surrogate' }));
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            data: body.input.map((value, index) => ({ index, embedding: index ? [0, 1, 0] : [1, 0, 0] }))
        }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const port = server.address().port;

    const { stdout } = await execFileAsync(process.execPath, ['scripts/etl_cards_lancedb.js'], {
        cwd: path.resolve('.'),
        env: {
            ...process.env,
            CHARACTER_ARCHIVE_DB_FILE: databasePath,
            CHARACTER_ARCHIVE_CONFIG_FILE: configPath,
            SEARCH_LANCE_PATH: lancePath,
            LANCE_VECTOR_TABLE: 'test_vectors',
            LCR_VECTOR_IDS: '1,2,3',
            EMBED_DIMENSIONS: '3',
            EMBEDDING_PROVIDER: 'openai',
            EMBEDDING_URL: `http://127.0.0.1:${port}`,
            EMBED_MODEL: 'test-model',
            EMBEDDING_TOKEN_BUDGET: '8000'
        }
    });
    const result = validateVectorEtlResult(parseVectorEtlResult(stdout), {
        upsertCount: 3,
        forceReembed: true
    });
    assert.equal(result.cardUpdates, 3);

    const connection = await lancedb.connect(lancePath);
    const table = await connection.openTable('test_vectors');
    assert.equal(await table.countRows(), 3);
    await table.close();
    await connection.close();
});
