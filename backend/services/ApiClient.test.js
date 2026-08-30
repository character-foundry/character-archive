import test from 'node:test';
import assert from 'node:assert/strict';

import { retryTransientRequest } from './ApiClient.js';

test('transient upstream failures are retried with bounded delays', async () => {
    let attempts = 0;
    const slept = [];
    const result = await retryTransientRequest(async () => {
        attempts += 1;
        if (attempts < 3) {
            const error = new Error('upstream unavailable');
            error.response = { status: 500 };
            throw error;
        }
        return 'ok';
    }, {
        delays: [25, 50],
        sleep: async delay => slept.push(delay)
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(slept, [25, 50]);
});

test('permanent HTTP failures are not retried', async () => {
    let attempts = 0;
    const failure = new Error('not found');
    failure.response = { status: 404 };

    await assert.rejects(
        retryTransientRequest(async () => {
            attempts += 1;
            throw failure;
        }, { delays: [0, 0], sleep: async () => {} }),
        error => error === failure
    );
    assert.equal(attempts, 1);
});
