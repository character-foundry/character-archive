import assert from 'node:assert/strict';
import test from 'node:test';

import { fuseHybridSearchIds, prioritizeLiteralTitleMatches } from './hybrid-ranking.js';

test('hybrid fusion honors semantic ratio and rewards agreement', () => {
    const vectorIds = ['semantic-only', 'shared', 'title-match'];
    const lexicalIds = ['keyword-only', 'shared', 'title-match'];

    assert.deepEqual(fuseHybridSearchIds({ vectorIds, lexicalIds, semanticRatio: 1 }), vectorIds);
    assert.deepEqual(fuseHybridSearchIds({ vectorIds, lexicalIds, semanticRatio: 0 }), lexicalIds);
    assert.equal(fuseHybridSearchIds({ vectorIds, lexicalIds, semanticRatio: 0.5 })[0], 'shared');
});

test('literal title matches stay ahead of looser semantic matches', () => {
    const ids = ['semantic-only', 'description-match', 'title-match'];
    const cards = [
        { id: 'semantic-only', name: 'A Similar Adventure' },
        { id: 'description-match', name: 'Unrelated Dispatch' },
        { id: 'title-match', name: 'The Heroes Party' }
    ];
    assert.equal(prioritizeLiteralTitleMatches(ids, cards, 'heroes party')[0], 'title-match');
    assert.deepEqual(
        prioritizeLiteralTitleMatches(ids, cards, 'heroes AND party'),
        ids,
        'Boolean expressions keep their fused ordering'
    );
});
