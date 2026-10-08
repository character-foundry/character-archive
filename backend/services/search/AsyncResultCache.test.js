import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResultCache } from './AsyncResultCache.js';

test('concurrent searches share work and each caller receives independent metadata', async () => {
    const cache = new AsyncResultCache();
    let calls = 0;
    const compute = async () => { calls++; return { ids: ['1'], meta: { total: 1 } }; };
    const [first, second] = await Promise.all([cache.get('query', compute), cache.get('query', compute)]);
    first.meta.total = 99;
    assert.equal(second.meta.total, 1);
    assert.equal((await cache.get('query', compute)).meta.total, 1);
    assert.equal(calls, 1);
});

test('expired, invalidated, and failed searches are recomputed', async () => {
    let now = 0;
    const cache = new AsyncResultCache({ ttlMs: 10, maxEntries: 2, now: () => now });
    let calls = 0;
    const compute = () => ++calls;
    assert.equal(await cache.get('q', compute), 1);
    now = 11;
    assert.equal(await cache.get('q', compute), 2);
    cache.clear();
    assert.equal(await cache.get('q', compute), 3);
    await assert.rejects(cache.get('bad', () => { throw new Error('offline'); }), /offline/);
    assert.equal(await cache.get('bad', compute), 4);
    await cache.get('other', compute);
    assert.equal(cache.entries.size, 2);
    assert.equal(await cache.get('q', compute), 6);
});
