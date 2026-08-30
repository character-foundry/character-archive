import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateVectorBenchmark } from './vector-benchmark-policy.js';

test('candidate-only vector quality gates do not require Meilisearch', () => {
    const result = evaluateVectorBenchmark({
        candidate: { hitRate10: 0.9, mrr10: 0.75, top1Rate: 0.65, latencyP95Ms: 350 }
    });
    assert.equal(result.passed, true);
    assert.equal('overlap10Floor' in result.thresholds, false);
});

test('relative vector quality gates retain overlap and regression checks', () => {
    const baseline = { hitRate10: 0.95, mrr10: 0.8, top1Rate: 0.7, latencyP95Ms: 200 };
    assert.equal(evaluateVectorBenchmark({
        baseline,
        overlap10: 0.8,
        candidate: { hitRate10: 0.94, mrr10: 0.78, top1Rate: 0.68, latencyP95Ms: 240 }
    }).passed, true);
    assert.equal(evaluateVectorBenchmark({
        baseline,
        overlap10: 0.5,
        candidate: { hitRate10: 0.94, mrr10: 0.78, top1Rate: 0.68, latencyP95Ms: 240 }
    }).passed, false);
});
