import test from 'node:test';
import assert from 'node:assert/strict';

import { isRemoteTimestampNewer } from './BaseScraper.js';

test('timestamp comparison ignores precision the archive cannot persist', () => {
    assert.equal(
        isRemoteTimestampNewer('2026-08-15 18:25:00', '2026-08-15T18:25:00.548Z'),
        false
    );
    assert.equal(
        isRemoteTimestampNewer('2026-08-15 18:25:00', '2026-08-15T18:25:01.001Z'),
        true
    );
});

test('timestamp comparison interprets archive timestamps as UTC', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        assert.equal(
            isRemoteTimestampNewer('2026-08-15 18:25:00', '2026-08-15T18:25:00.000Z'),
            false
        );
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test('timestamp comparison refreshes when either timestamp is invalid', () => {
    assert.equal(isRemoteTimestampNewer('not-a-date', '2026-08-15T18:25:00Z'), true);
    assert.equal(isRemoteTimestampNewer('2026-08-15 18:25:00', 'not-a-date'), true);
});
