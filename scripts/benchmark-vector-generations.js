#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { MeiliSearch } from 'meilisearch';

import { initDatabase } from '../backend/database.js';
import { getVectorGenerationRepository } from '../backend/db/repositories/VectorGenerationRepository.js';
import { requestEmbeddings } from '../backend/services/EmbeddingClient.js';
import { loadConfig, writeJsonAtomically } from '../config-loader.js';

function arg(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const baselineId = Number(arg('--baseline'));
const candidateId = Number(arg('--candidate'));
const fixturePath = path.resolve(arg('--fixture') || 'benchmarks/vector-search-queries.json');
const outputPath = path.resolve(arg('--output') || `benchmarks/vector-report-${Date.now()}.json`);
if (!baselineId || !candidateId) throw new Error('Usage: --baseline ID --candidate ID [--fixture FILE] [--output FILE]');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
if (!Array.isArray(fixture) || fixture.length < 120) throw new Error('Vector benchmark fixture must contain at least 120 queries');
for (const item of fixture) {
    if (!item?.query || !Array.isArray(item.expectedIds) || !item.expectedIds.length) {
        throw new Error('Each fixture entry requires query and expectedIds');
    }
}

initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const repository = getVectorGenerationRepository();
const baseline = repository.get(baselineId);
const candidate = repository.get(candidateId);
if (!baseline || !candidate) throw new Error('Baseline or candidate generation was not found');
if (!['ready', 'active'].includes(baseline.status) || !['ready', 'active'].includes(candidate.status)) {
    throw new Error('Both generations must be ready or active before benchmarking');
}

const config = loadConfig();
const meili = new MeiliSearch({ host: config.meilisearch.host, apiKey: config.meilisearch.apiKey });

async function runGeneration(generation) {
    const results = [];
    const latencies = [];
    for (const fixtureItem of fixture) {
        const startedAt = performance.now();
        const [vector] = await requestEmbeddings({
            provider: config.vectorSearch.embeddingProvider,
            baseUrl: config.vectorSearch.embeddingUrl || config.vectorSearch.ollamaUrl,
            apiKey: config.vectorSearch.embeddingApiKey,
            model: generation.model_name,
            texts: [fixtureItem.query],
            dimensions: generation.dimensions,
            normalize: true
        });
        const response = await meili.index(generation.cards_index).search(fixtureItem.query, {
            vector,
            hybrid: { embedder: generation.embedder_name, semanticRatio: 1 },
            limit: 10,
            attributesToRetrieve: ['id']
        });
        latencies.push(performance.now() - startedAt);
        results.push(response.hits.map(hit => String(hit.id)));
    }

    let hits = 0;
    let reciprocalRank = 0;
    let top1 = 0;
    results.forEach((ids, index) => {
        const expected = new Set(fixture[index].expectedIds.map(String));
        const rank = ids.findIndex(id => expected.has(id));
        if (rank >= 0) {
            hits++;
            reciprocalRank += 1 / (rank + 1);
            if (rank === 0) top1++;
        }
    });
    return {
        generationId: generation.id,
        model: generation.model_name,
        dimensions: generation.dimensions,
        hitRate10: hits / fixture.length,
        mrr10: reciprocalRank / fixture.length,
        top1Rate: top1 / fixture.length,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95),
        results
    };
}

const baselineResult = await runGeneration(baseline);
const candidateResult = await runGeneration(candidate);
let overlapTotal = 0;
for (let index = 0; index < fixture.length; index++) {
    const baselineSet = new Set(baselineResult.results[index]);
    overlapTotal += candidateResult.results[index].filter(id => baselineSet.has(id)).length / 10;
}
const overlap10 = overlapTotal / fixture.length;

const thresholds = {
    hitRate10Floor: Math.max(0.8, baselineResult.hitRate10 - 0.02),
    mrr10Floor: Math.max(0.6, baselineResult.mrr10 - 0.03),
    top1RateFloor: Math.max(0.5, baselineResult.top1Rate - 0.03),
    overlap10Floor: 0.75,
    latencyP95CeilingMs: Math.max(baselineResult.latencyP95Ms * 1.25, baselineResult.latencyP95Ms + 50)
};
const passed = candidateResult.hitRate10 >= thresholds.hitRate10Floor
    && candidateResult.mrr10 >= thresholds.mrr10Floor
    && candidateResult.top1Rate >= thresholds.top1RateFloor
    && overlap10 >= thresholds.overlap10Floor
    && candidateResult.latencyP95Ms <= thresholds.latencyP95CeilingMs;

delete baselineResult.results;
delete candidateResult.results;
const report = {
    passed,
    fixture: fixturePath,
    queryCount: fixture.length,
    createdAt: new Date().toISOString(),
    thresholds,
    overlap10,
    baseline: baselineResult,
    candidate: candidateResult
};
writeJsonAtomically(outputPath, report);
process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
