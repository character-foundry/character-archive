import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseVectorEtlResult,
    resolveExplicitIdMode,
    validateVectorEtlResult,
    VECTOR_RESULT_PREFIX
} from './vector-etl-contract.js';

test('explicit shadow batches preserve forced re-embedding', () => {
    assert.deepEqual(resolveExplicitIdMode({ forceReembed: true, chunksEnabled: true }), {
        forceReembedAll: true,
        forceChunkReembed: true,
        verifyCardDocs: false
    });
    assert.deepEqual(resolveExplicitIdMode(), {
        forceReembedAll: false,
        forceChunkReembed: false,
        verifyCardDocs: false
    });
});

test('worker accepts a complete forced ETL result', () => {
    const result = parseVectorEtlResult(`noise\n${VECTOR_RESULT_PREFIX}{"processed":100,"cardUpdates":99,"skippedNoText":1,"skippedUnchanged":0}\n`);
    assert.equal(validateVectorEtlResult(result, { upsertCount: 100, forceReembed: true }), result);
});

test('worker rejects false completion during a forced shadow rebuild', () => {
    assert.throws(
        () => validateVectorEtlResult({
            processed: 100,
            cardUpdates: 3,
            skippedNoText: 0,
            skippedUnchanged: 97
        }, { upsertCount: 100, forceReembed: true }),
        /skipped 97 unchanged cards/
    );
});

test('worker rejects missing claimed work items', () => {
    assert.throws(
        () => validateVectorEtlResult({ processed: 99 }, { upsertCount: 100, forceReembed: true }),
        /processed 99\/100/
    );
});
