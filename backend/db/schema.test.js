import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureSchema } from './schema.js';

test('vector queue coalesces repeated changes for a card', () => {
    const database = new Database(':memory:');
    try {
        ensureSchema(database);
        database.prepare('INSERT INTO cards (id, name) VALUES (?, ?)').run(1, 'First');
        database.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Second', 1);
        database.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Third', 1);

        assert.deepEqual(
            database.prepare('SELECT cardId, action FROM vector_index_queue').all(),
            [{ cardId: '1', action: 'upsert' }]
        );

        database.prepare('DELETE FROM cards WHERE id = ?').run(1);
        assert.deepEqual(
            database.prepare('SELECT cardId, action FROM vector_index_queue').all(),
            [{ cardId: '1', action: 'delete' }]
        );
    } finally {
        database.close();
    }
});

test('schema setup compacts an existing duplicate vector queue', () => {
    const database = new Database(':memory:');
    try {
        database.exec(`
            CREATE TABLE vector_index_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cardId TEXT NOT NULL,
                action TEXT NOT NULL,
                queuedAt TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO vector_index_queue(cardId, action) VALUES ('12', 'upsert');
            INSERT INTO vector_index_queue(cardId, action) VALUES ('12', 'delete');
        `);

        ensureSchema(database);

        assert.deepEqual(
            database.prepare('SELECT cardId, action FROM vector_index_queue').all(),
            [{ cardId: '12', action: 'delete' }]
        );
        assert.throws(
            () => database.prepare("INSERT INTO vector_index_queue(cardId, action) VALUES ('12', 'upsert')").run(),
            /UNIQUE constraint failed/
        );
    } finally {
        database.close();
    }
});

test('schema exposes durable sync runs and per-source outcomes', () => {
    const database = new Database(':memory:');
    try {
        ensureSchema(database);

        const run = database.prepare(`
            INSERT INTO sync_runs (trigger_type, requested_sources, scheduled_for)
            VALUES ('manual', '["chub","ct"]', '2026-08-30T04:00:00.000Z')
            RETURNING id, status, cancel_requested
        `).get();
        assert.deepEqual(run, { id: 1, status: 'queued', cancel_requested: 0 });

        database.prepare(`
            INSERT INTO sync_source_runs (run_id, source, status, added, updated, skipped, errors)
            VALUES (?, 'ct', 'partial', 2, 3, 4, 1)
        `).run(run.id);

        assert.deepEqual(
            database.prepare('SELECT source, status, added, updated, skipped, errors FROM sync_source_runs WHERE run_id = ?').get(run.id),
            { source: 'ct', status: 'partial', added: 2, updated: 3, skipped: 4, errors: 1 }
        );
        assert.throws(
            () => database.prepare("INSERT INTO sync_source_runs (run_id, source) VALUES (1, 'ct')").run(),
            /UNIQUE constraint failed/
        );
    } finally {
        database.close();
    }
});

test('schema exposes model-aware vector generations and durable work items', () => {
    const database = new Database(':memory:');
    try {
        ensureSchema(database);

        const generation = database.prepare(`
            INSERT INTO vector_generations (
                name, model_name, embedder_name, dimensions, cards_index, chunks_index
            ) VALUES ('qwen-1280-shadow', 'qwen3-embedding-4b', 'qwen3-1280', 1280, 'cards_vsem_g1', 'chunks_g1')
            RETURNING id, status, active
        `).get();
        assert.deepEqual(generation, { id: 1, status: 'building', active: 0 });

        database.prepare(`
            INSERT INTO vector_work_items (generation_id, card_id, action)
            VALUES (?, '42', 'upsert')
            ON CONFLICT(generation_id, card_id) DO UPDATE SET action = excluded.action
        `).run(generation.id);
        database.prepare(`
            INSERT INTO vector_work_items (generation_id, card_id, action)
            VALUES (?, '42', 'delete')
            ON CONFLICT(generation_id, card_id) DO UPDATE SET action = excluded.action
        `).run(generation.id);

        assert.deepEqual(
            database.prepare('SELECT card_id, action, status, attempts FROM vector_work_items').all(),
            [{ card_id: '42', action: 'delete', status: 'queued', attempts: 0 }]
        );
    } finally {
        database.close();
    }
});

test('card changes requeue building and ready vector generations', () => {
    const database = new Database(':memory:');
    try {
        ensureSchema(database);
        const generation = database.prepare(`
            INSERT INTO vector_generations (
                name, model_name, embedder_name, dimensions, cards_index, chunks_index
            ) VALUES ('candidate', 'model', 'embedder', 8, 'cards_g1', 'chunks_g1')
            RETURNING id
        `).get();

        database.prepare("INSERT INTO cards (id, name) VALUES (1, 'first')").run();
        assert.equal(database.prepare('SELECT status FROM vector_work_items WHERE generation_id = ? AND card_id = ?').get(generation.id, '1').status, 'queued');

        database.prepare("UPDATE vector_work_items SET status = 'completed' WHERE generation_id = ?").run(generation.id);
        database.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(generation.id);
        database.prepare("UPDATE cards SET name = 'changed' WHERE id = 1").run();

        assert.equal(database.prepare('SELECT status FROM vector_generations WHERE id = ?').get(generation.id).status, 'building');
        assert.deepEqual(
            database.prepare('SELECT status, action, revision FROM vector_work_items WHERE generation_id = ? AND card_id = ?').get(generation.id, '1'),
            { status: 'queued', action: 'upsert', revision: 1 }
        );
    } finally {
        database.close();
    }
});
