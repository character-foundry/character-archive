import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureSchema } from '../schema.js';
import { createVectorGenerationRepository } from './VectorGenerationRepository.js';

function harness() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    db.prepare("INSERT INTO cards (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')").run();
    return { db, vectors: createVectorGenerationRepository(db) };
}

test('reconcile creates a shadow generation and seeds every card exactly once', () => {
    const { db, vectors } = harness();
    try {
        const generation = vectors.reconcile({
            modelName: 'qwen3-embedding-4b', embedderName: 'qwen3-1280', dimensions: 1280,
            cardsIndexBase: 'cards_vsem', chunksIndexBase: 'card_chunks'
        });
        const repeated = vectors.reconcile({
            modelName: 'qwen3-embedding-4b', embedderName: 'qwen3-1280', dimensions: 1280,
            cardsIndexBase: 'cards_vsem', chunksIndexBase: 'card_chunks'
        });

        assert.equal(repeated.id, generation.id);
        assert.match(generation.cards_index, /^cards_vsem_g\d+$/);
        assert.equal(generation.expected_cards, 3);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vector_work_items').get().count, 3);
    } finally {
        db.close();
    }
});

test('reconcile strips an existing generation suffix and rejects invalid dimensions', () => {
    const { db, vectors } = harness();
    try {
        const generation = vectors.reconcile({
            modelName: 'model', embedderName: 'embedder', dimensions: 8,
            cardsIndexBase: 'cards_vsem_g41', chunksIndexBase: 'card_chunks_g41'
        });
        assert.equal(generation.cards_index, 'cards_vsem_g1');
        assert.equal(generation.chunks_index, 'card_chunks_g1');
        assert.throws(
            () => vectors.reconcile({ modelName: 'bad', embedderName: 'bad', dimensions: 0 }),
            /positive integer/
        );
    } finally {
        db.close();
    }
});

test('work leases retry and only complete after the worker reports success', () => {
    const { db, vectors } = harness();
    try {
        const generation = vectors.reconcile({
            modelName: 'model', embedderName: 'embedder', dimensions: 8,
            cardsIndexBase: 'cards', chunksIndexBase: 'chunks'
        });
        const claimed = vectors.claimBatch({ generationId: generation.id, workerId: 'worker-a', limit: 2 });
        assert.equal(claimed.length, 2);
        assert.equal(vectors.get(generation.id).completed_items, 0);

        vectors.failItems(claimed.map(item => item.id), new Error('inference down'), { maxAttempts: 3 });
        assert.equal(vectors.get(generation.id).retry_items, 2);
        db.prepare("UPDATE vector_work_items SET next_attempt_at = '1970-01-01' WHERE status = 'retry'").run();
        const retried = vectors.claimBatch({ generationId: generation.id, workerId: 'worker-b', limit: 2 });
        vectors.completeItems(retried.map(item => item.id));
        assert.equal(vectors.get(generation.id).completed_items, 2);
    } finally {
        db.close();
    }
});

test('a stale failed lease cannot overwrite a newer queued revision', () => {
    const { db, vectors } = harness();
    try {
        const generation = vectors.reconcile({
            modelName: 'model', embedderName: 'embedder', dimensions: 8,
            cardsIndexBase: 'cards', chunksIndexBase: 'chunks'
        });
        const [leased] = vectors.claimBatch({ generationId: generation.id, workerId: 'worker-a', limit: 1 });
        db.prepare('UPDATE cards SET name = ? WHERE id = ?').run('new revision', Number(leased.card_id));

        vectors.failItems([leased.id], new Error('old request failed'), { maxAttempts: 1 });
        const current = db.prepare('SELECT status, revision, leased_revision FROM vector_work_items WHERE id = ?').get(leased.id);
        assert.equal(current.status, 'queued');
        assert.ok(current.revision > current.leased_revision);
    } finally {
        db.close();
    }
});

test('activation requires a ready generation and retires the prior pointer for seven days', () => {
    const { db, vectors } = harness();
    try {
        const first = vectors.reconcile({ modelName: 'm1', embedderName: 'e1', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(first.id);
        vectors.activate(first.id, { qualityApproved: true, now: '2026-08-30T00:00:00.000Z' });

        const second = vectors.reconcile({ modelName: 'm2', embedderName: 'e2', dimensions: 4, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(second.id);
        assert.throws(() => vectors.activate(second.id), /quality approval/);
        vectors.activate(second.id, { qualityApproved: true, now: '2026-08-31T00:00:00.000Z' });

        const old = vectors.get(first.id);
        assert.equal(old.status, 'retired');
        assert.equal(old.retire_after, '2026-09-07T00:00:00.000Z');
        assert.equal(vectors.get(second.id).active, true);
    } finally {
        db.close();
    }
});

test('activation rolls back the database pointer when config persistence fails', () => {
    const { db, vectors } = harness();
    try {
        const first = vectors.reconcile({ modelName: 'm1', embedderName: 'e1', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(first.id);
        vectors.activate(first.id, { qualityApproved: true });
        const second = vectors.reconcile({ modelName: 'm2', embedderName: 'e2', dimensions: 4, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(second.id);

        assert.throws(() => vectors.activate(second.id, {
            qualityApproved: true,
            beforeCommit: () => { throw new Error('disk full'); }
        }), /disk full/);
        assert.equal(vectors.get(first.id).active, true);
        assert.equal(vectors.get(first.id).status, 'active');
        assert.equal(vectors.get(second.id).active, false);
        assert.equal(vectors.get(second.id).status, 'ready');
    } finally {
        db.close();
    }
});

test('a failed generation resumes only its dead work with the same model specification', () => {
    const { db, vectors } = harness();
    try {
        const failed = vectors.reconcile({ modelName: 'model', embedderName: 'embedder', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        const completed = vectors.claimBatch({ generationId: failed.id, workerId: 'worker-a', limit: 2 });
        vectors.completeItems(completed.map(item => item.id));
        const dead = vectors.claimBatch({ generationId: failed.id, workerId: 'worker-a', limit: 1 });
        vectors.failItems(dead.map(item => item.id), new Error('bad endpoint'), { maxAttempts: 1 });
        assert.equal(vectors.get(failed.id).status, 'failed');

        const retry = vectors.reconcile({ modelName: 'model', embedderName: 'embedder', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        assert.equal(retry.id, failed.id);
        assert.equal(retry.status, 'building');
        assert.equal(retry.completed_items, 2);
        assert.equal(retry.retry_items, 1);
        assert.equal(retry.dead_items, 0);
    } finally {
        db.close();
    }
});

test('forced reconcile creates a repair shadow when only the matching active generation exists', () => {
    const { db, vectors } = harness();
    try {
        const active = vectors.reconcile({ modelName: 'model', embedderName: 'embedder', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(active.id);
        vectors.activate(active.id, { qualityApproved: true });

        const shadow = vectors.reconcile({
            modelName: 'model', embedderName: 'embedder', dimensions: 8,
            cardsIndexBase: 'cards', chunksIndexBase: 'chunks', forceNewGeneration: true
        });
        assert.notEqual(shadow.id, active.id);
        assert.equal(shadow.status, 'building');
        assert.equal(shadow.active, false);
    } finally {
        db.close();
    }
});

test('active index maintenance is processed before a shadow rebuild', () => {
    const { db, vectors } = harness();
    try {
        const active = vectors.reconcile({ modelName: 'm1', embedderName: 'e1', dimensions: 8, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE vector_work_items SET status = 'completed' WHERE generation_id = ?").run(active.id);
        db.prepare("UPDATE vector_generations SET status = 'ready' WHERE id = ?").run(active.id);
        vectors.activate(active.id, { qualityApproved: true });
        const shadow = vectors.reconcile({ modelName: 'm2', embedderName: 'e2', dimensions: 4, cardsIndexBase: 'cards', chunksIndexBase: 'chunks' });
        db.prepare("UPDATE cards SET name = 'changed' WHERE id = 1").run();

        assert.equal(vectors.currentBuild().id, active.id);
        db.prepare("UPDATE vector_work_items SET status = 'completed' WHERE generation_id = ?").run(active.id);
        assert.equal(vectors.currentBuild().id, shadow.id);
    } finally {
        db.close();
    }
});
