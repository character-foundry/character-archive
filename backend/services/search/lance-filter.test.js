import assert from 'node:assert/strict';
import test from 'node:test';

import { compileLanceFilter } from './lance-filter.js';

test('compiles generated advanced filters to Lance SQL', () => {
    assert.equal(
        compileLanceFilter('hasLorebook = true AND tokenCount >= 1200 AND source = "ct"'),
        '((hasLorebook = true) AND (tokenCount >= 1200)) AND (source = \'ct\')'
    );
});

test('compiles tag membership, exclusions, and grouped alternatives', () => {
    assert.equal(
        compileLanceFilter('(tags = "fantasy" OR tags = "sci-fi") AND NOT tags = "gore"'),
        "((array_contains(tags, 'fantasy')) OR (array_contains(tags, 'sci-fi'))) AND (NOT array_contains(tags, 'gore'))"
    );
});

test('normalizes supported colon syntax and aliases', () => {
    assert.equal(
        compileLanceFilter('language:en AND token_count:2500'),
        "(language = 'en') AND (tokenCount = 2500)"
    );
    assert.equal(compileLanceFilter('createdAt:2026-01-01'), "createdAt = '2026-01-01'");
    assert.equal(compileLanceFilter('id:12345'), "id = '12345'");
});

test('escapes strings and rejects unsupported fields', () => {
    assert.equal(compileLanceFilter('author = "O\'Brien"'), "author = 'O''Brien'");
    assert.throws(() => compileLanceFilter('password = "secret"'), /Unsupported search filter field/);
});

test('empty filters stay empty', () => {
    assert.equal(compileLanceFilter(''), '');
});
