import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureSchema } from '../schema.js';
import { createSyncRunRepository } from './SyncRunRepository.js';

function createHarness() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    return { db, runs: createSyncRunRepository(db) };
}

test('scheduled boundaries enqueue exactly once', () => {
    const { db, runs } = createHarness();
    try {
        const first = runs.enqueue({
            triggerType: 'scheduled',
            scheduleKey: '2026-08-30T04:00:00.000Z',
            scheduledFor: '2026-08-30T04:00:00.000Z',
            sources: ['chub', 'ct']
        });
        const second = runs.enqueue({
            triggerType: 'scheduled',
            scheduleKey: '2026-08-30T04:00:00.000Z',
            scheduledFor: '2026-08-30T04:00:00.000Z',
            sources: ['chub', 'ct']
        });

        assert.equal(second.id, first.id);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 1);
        assert.deepEqual(runs.get(first.id).sources.map(source => source.source), ['chub', 'ct']);
    } finally {
        db.close();
    }
});

test('expired worker lease is recovered and a run can be cancelled', () => {
    const { db, runs } = createHarness();
    try {
        const run = runs.enqueue({ sources: ['ct'] });
        const claimed = runs.claimNext({
            workerId: 'worker-a',
            now: '2026-08-30T05:00:00.000Z',
            leaseSeconds: 30
        });
        assert.equal(claimed.id, run.id);
        assert.equal(claimed.status, 'running');

        const nothing = runs.claimNext({
            workerId: 'worker-b',
            now: '2026-08-30T05:00:10.000Z',
            leaseSeconds: 30
        });
        assert.equal(nothing, null);

        const recovered = runs.claimNext({
            workerId: 'worker-b',
            now: '2026-08-30T05:01:00.000Z',
            leaseSeconds: 30
        });
        assert.equal(recovered.id, run.id);
        assert.equal(recovered.lease_owner, 'worker-b');

        runs.requestCancel(run.id);
        assert.equal(runs.isCancellationRequested(run.id), true);
        runs.finishRun(run.id, 'cancelled');
        assert.equal(runs.get(run.id).status, 'cancelled');
    } finally {
        db.close();
    }
});

test('run outcome is derived from all source outcomes and exposes progress events', () => {
    const { db, runs } = createHarness();
    try {
        const run = runs.enqueue({ sources: ['chub', 'ct', 'risuai'] });
        runs.claimNext({ workerId: 'worker-a' });
        runs.startSource(run.id, 'chub');
        runs.finishSource(run.id, 'chub', { status: 'success', added: 2, updated: 1 });
        runs.startSource(run.id, 'ct');
        runs.appendEvent(run.id, 'ct', 'progress', { processed: 5, currentCard: 'Test' });
        runs.finishSource(run.id, 'ct', { status: 'failed', errors: 1, error: 'upstream 502' });
        runs.finishSource(run.id, 'risuai', { status: 'skipped' });

        const final = runs.finalize(run.id);
        assert.equal(final.status, 'partial');
        assert.deepEqual(
            { added: final.added, updated: final.updated, errors: final.errors },
            { added: 2, updated: 1, errors: 1 }
        );
        assert.deepEqual(runs.listEvents(run.id, 0).map(event => event.payload), [
            { processed: 5, currentCard: 'Test' }
        ]);
    } finally {
        db.close();
    }
});
