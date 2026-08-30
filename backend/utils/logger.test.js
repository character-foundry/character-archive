import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogValue } from './logger.js';

test('log metadata keeps error context while redacting credentials', () => {
    const error = new Error('Request failed with status code 404');
    error.code = 'ERR_BAD_REQUEST';
    error.status = 404;
    error.config = {
        headers: {
            Authorization: 'Bearer secret',
            'CH-API-KEY': 'secret',
            samwise: 'secret',
            Accept: 'application/json'
        },
        apiKey: 'secret',
        url: 'https://example.invalid/card.png'
    };

    assert.deepEqual(sanitizeLogValue(error), {
        name: 'Error',
        message: 'Request failed with status code 404',
        code: 'ERR_BAD_REQUEST',
        status: 404
    });

    assert.deepEqual(sanitizeLogValue(error.config), {
        headers: {
            Authorization: '[REDACTED]',
            'CH-API-KEY': '[REDACTED]',
            samwise: '[REDACTED]',
            Accept: 'application/json'
        },
        apiKey: '[REDACTED]',
        url: 'https://example.invalid/card.png'
    });
});
