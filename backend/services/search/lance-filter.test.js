import assert from 'node:assert/strict';
import test from 'node:test';

import { compileLanceFilter } from './lance-filter.js';

test('compiles generated advanced filters to Lance SQL', () => {
    assert.equal(
        compileLanceFilter('hasLorebook = true AND tokenCount >= 1200 AND source = "ct"'),
        '((hasLorebook = true) AND (tokenCount >= 1200)) AND (LOWER(source) = \'ct\')'
    );
});

test('compiles tag membership, exclusions, and grouped alternatives', () => {
    assert.equal(
        compileLanceFilter('(tags = "fantasy" OR tags = "sci-fi") AND NOT tags = "gore"'),
        "((array_contains(tags, 'fantasy')) OR (array_contains(tags, 'sci-fi'))) AND (NOT (array_contains(tags, 'gore')))"
    );
});

test('preserves grouped negation semantics', () => {
    assert.equal(
        compileLanceFilter('NOT (hasLorebook = true OR hasGallery = true)'),
        'NOT ((hasLorebook = true) OR (hasGallery = true))'
    );
});

test('accepts Meilisearch IN lists for portable filters', () => {
    assert.equal(
        compileLanceFilter('source IN ["ct", "chub"]'),
        "LOWER(source) IN ('ct', 'chub')"
    );
    assert.equal(
        compileLanceFilter('tags IN ["fantasy", "sci-fi"]'),
        "(array_contains(tags, 'fantasy') OR array_contains(tags, 'sci-fi'))"
    );
});

test('supports Meilisearch ranges and existence checks', () => {
    assert.equal(
        compileLanceFilter('tokenCount 1000 TO 2000'),
        '(tokenCount >= 1000) AND (tokenCount <= 2000)'
    );
    assert.equal(
        compileLanceFilter('source NOT IN ["risuai", "wyvern"]'),
        "NOT (LOWER(source) IN ('risuai', 'wyvern'))"
    );
    assert.equal(
        compileLanceFilter('hasLorebook EXISTS'),
        'hasLorebook IS NOT NULL'
    );
});

test('keeps colons inside quoted values and supports date shorthand', () => {
    assert.equal(
        compileLanceFilter('name = "Star: Pilot"'),
        "LOWER(name) = 'star: pilot'"
    );
    assert.equal(
        compileLanceFilter('createdAt:2026-01-01'),
        "LOWER(createdAt) = '2026-01-01'"
    );
});

test('compares string filter values without case sensitivity', () => {
    assert.equal(
        compileLanceFilter('author = "Anonymous"'),
        "LOWER(author) = 'anonymous'"
    );
});

test('normalizes supported colon syntax and aliases', () => {
    assert.equal(
        compileLanceFilter('language:en AND token_count:2500'),
        "(LOWER(language) = 'en') AND (tokenCount = 2500)"
    );
    assert.equal(compileLanceFilter('createdAt:2026-01-01'), "LOWER(createdAt) = '2026-01-01'");
    assert.equal(compileLanceFilter('id:12345'), "LOWER(id) = '12345'");
});

test('escapes strings and rejects unsupported fields', () => {
    assert.equal(compileLanceFilter('author = "O\'Brien"'), "LOWER(author) = 'o''brien'");
    assert.throws(() => compileLanceFilter('password = "secret"'), /Unsupported search filter field/);
});

test('empty filters stay empty', () => {
    assert.equal(compileLanceFilter(''), '');
});
