import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureSchema } from '../db/schema.js';
import { createCtRepairService } from './CtRepairService.js';

test('CT duplicate repair preserves the canonical identity, favorite, earliest date, and merged tags', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    db.prepare(`
        INSERT INTO cards (id, name, source, sourceId, sourcePath, favorited, firstDownloadedAt)
        VALUES (10, 'Old', 'ct', 'old-version', 'Alice/Test_Card', 0, '2026-02-01T00:00:00.000Z'),
               (11, 'New', 'ct', 'new-version', 'alice/test_card', 1, '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare("INSERT INTO card_tags (cardId, tag, normalizedTag) VALUES (10, 'one', 'one'), (11, 'two', 'two')").run();
    db.prepare('DELETE FROM search_index_queue').run();
    db.prepare('DELETE FROM vector_index_queue').run();

    try {
        const repair = createCtRepairService(db);
        const plan = repair.plan();
        assert.deepEqual(plan.groups.map(group => ({ canonicalId: group.canonicalId, loserIds: group.loserIds })), [
            { canonicalId: 10, loserIds: [11] }
        ]);

        const result = repair.apply(plan);
        assert.equal(result.mergedRows, 1);
        assert.deepEqual(
            db.prepare('SELECT id, favorited, firstDownloadedAt FROM cards').all(),
            [{ id: 10, favorited: 1, firstDownloadedAt: '2026-01-01T00:00:00.000Z' }]
        );
        assert.deepEqual(
            db.prepare('SELECT tag FROM card_tags WHERE cardId = 10 ORDER BY tag').all(),
            [{ tag: 'one' }, { tag: 'two' }]
        );
        assert.deepEqual(
            db.prepare('SELECT canonical_card_id, retired_card_id FROM card_source_aliases').all(),
            [{ canonical_card_id: 10, retired_card_id: 11 }]
        );
        assert.throws(
            () => db.prepare("INSERT INTO cards (id, source, sourcePath) VALUES (12, 'ct', 'ALICE/TEST_CARD')").run(),
            /UNIQUE constraint failed/
        );
    } finally {
        db.close();
    }
});
