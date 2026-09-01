import test from 'node:test';
import assert from 'node:assert/strict';

import { drainDecision, shouldPauseForArchiveSync } from './vector-worker-policy.js';

test('LanceDB indexing continues while an archive sync is active', () => {
    assert.equal(shouldPauseForArchiveSync({ provider: 'lancedb' }), false);
});

test('Meilisearch indexing pauses during an archive sync by default', () => {
    assert.equal(shouldPauseForArchiveSync({ provider: 'meilisearch' }), true);
});

test('an explicit setting overrides the provider default', () => {
    assert.equal(shouldPauseForArchiveSync({ provider: 'lancedb', setting: 'true' }), true);
    assert.equal(shouldPauseForArchiveSync({ provider: 'meilisearch', setting: '0' }), false);
});

test('drain mode exits at a completed snapshot and reports a bounded timeout', () => {
    assert.equal(drainDecision({ enabled: false }), 'continue');
    assert.equal(drainDecision({ enabled: true, worked: true }), 'continue');
    assert.equal(drainDecision({ enabled: true, worked: false, generation: null }), 'complete');
    assert.equal(drainDecision({
        enabled: true,
        worked: false,
        generation: { queued_items: 2, retry_items: 0, running_items: 0 }
    }), 'wait');
    assert.equal(drainDecision({
        enabled: true,
        worked: false,
        generation: { status: 'failed', dead_items: 1 }
    }), 'failed');
    assert.equal(drainDecision({ enabled: true, deadlineReached: true }), 'timeout');
});
