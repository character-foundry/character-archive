import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureSchema } from '../db/schema.js';
import { createSyncRunRepository } from '../db/repositories/SyncRunRepository.js';
import { createArchiveSyncService } from './ArchiveSyncService.js';

function createHarness(sourceHandlers) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    const repository = createSyncRunRepository(db);
    const service = createArchiveSyncService({ repository, sourceHandlers });
    return { db, repository, service };
}

test('archive run continues after a source fails and records partial success', async () => {
    const called = [];
    const { db, repository, service } = createHarness({
        chub: async ({ progress }) => {
            called.push('chub');
            progress({ processed: 1, currentCard: 'one' });
            return { newCards: 2, updatedCards: 1, errors: 0 };
        },
        ct: async () => {
            called.push('ct');
            throw new Error('CT search returned 502');
        },
        risuai: async () => {
            called.push('risuai');
            return { added: 1, skipped: 3, errors: 0 };
        }
    });

    try {
        const queued = repository.enqueue({ sources: ['chub', 'ct', 'risuai'] });
        repository.claimNext({ workerId: 'worker-a' });
        const result = await service.execute(queued.id, { workerId: 'worker-a' });

        assert.deepEqual(called, ['chub', 'ct', 'risuai']);
        assert.equal(result.status, 'partial');
        assert.deepEqual(
            result.sources.map(source => [source.source, source.status]),
            [['chub', 'success'], ['ct', 'failed'], ['risuai', 'success']]
        );
        assert.equal(repository.listEvents(queued.id).length, 1);
    } finally {
        db.close();
    }
});

test('archive run stops before the next source after cancellation', async () => {
    const called = [];
    const { db, repository, service } = createHarness({
        chub: async () => {
            called.push('chub');
            repository.requestCancel(1);
            return { newCards: 1 };
        },
        ct: async () => {
            called.push('ct');
            return { added: 1 };
        }
    });

    try {
        const queued = repository.enqueue({ sources: ['chub', 'ct'] });
        repository.claimNext({ workerId: 'worker-a' });
        const result = await service.execute(queued.id, { workerId: 'worker-a' });

        assert.deepEqual(called, ['chub']);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.sources.find(source => source.source === 'chub').status, 'cancelled');
        assert.equal(result.sources.find(source => source.source === 'ct').status, 'cancelled');
    } finally {
        db.close();
    }
});

test('four-hour UTC boundary is stable and startup catch-up is idempotent', () => {
    const { db, repository, service } = createHarness({ chub: async () => ({}) });
    try {
        assert.equal(
            service.getBoundary(new Date('2026-08-30T05:59:42.000Z')).toISOString(),
            '2026-08-30T04:00:00.000Z'
        );
        const first = service.enqueueBoundary({
            now: new Date('2026-08-30T05:59:42.000Z'),
            sources: ['chub'],
            triggerType: 'startup-catchup'
        });
        const second = service.enqueueBoundary({
            now: new Date('2026-08-30T06:10:00.000Z'),
            sources: ['chub'],
            triggerType: 'startup-catchup'
        });
        assert.equal(second.id, first.id);
    } finally {
        db.close();
    }
});

test('archive run renews its lease while a quiet source handler is still running', async () => {
    const { db, repository, service } = createHarness({
        chub: async () => {
            await new Promise(resolve => setTimeout(resolve, 35));
            return { added: 1 };
        }
    });
    const originalRenewLease = repository.renewLease.bind(repository);
    let renewals = 0;
    repository.renewLease = (...args) => {
        renewals++;
        return originalRenewLease(...args);
    };

    try {
        const queued = repository.enqueue({ sources: ['chub'] });
        repository.claimNext({ workerId: 'worker-a' });
        await service.execute(queued.id, {
            workerId: 'worker-a',
            leaseSeconds: 1,
            heartbeatIntervalMs: 5
        });
        assert.ok(renewals >= 2, `expected recurring lease renewals, received ${renewals}`);
    } finally {
        db.close();
    }
});
