import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPauseForArchiveSync } from './vector-worker-policy.js';

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
