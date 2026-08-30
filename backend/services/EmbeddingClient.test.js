import test from 'node:test';
import assert from 'node:assert/strict';

import { requestEmbeddings } from './EmbeddingClient.js';

test('requests Ollama embeddings', async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return Response.json({ embeddings: [[1, 2], [3, 4]] });
    };

    const vectors = await requestEmbeddings({
        provider: 'ollama',
        baseUrl: 'http://ollama.test/',
        model: 'embed-model',
        texts: ['first', 'second'],
        fetchImpl
    });

    assert.deepEqual(vectors, [[1, 2], [3, 4]]);
    assert.equal(request.url, 'http://ollama.test/api/embed');
    assert.deepEqual(JSON.parse(request.options.body), {
        model: 'embed-model',
        input: ['first', 'second']
    });
    assert.equal(request.options.headers.Authorization, undefined);
});

test('requests OpenAI-compatible embeddings with authentication', async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return Response.json({
            data: [
                { index: 1, embedding: [3, 4] },
                { index: 0, embedding: [1, 2] }
            ]
        });
    };

    const vectors = await requestEmbeddings({
        provider: 'openai',
        baseUrl: 'https://inference.test/v1/',
        apiKey: 'test-key',
        model: 'embed-model',
        texts: ['first', 'second'],
        fetchImpl
    });

    assert.deepEqual(vectors, [[1, 2], [3, 4]]);
    assert.equal(request.url, 'https://inference.test/v1/embeddings');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(request.options.body), {
        model: 'embed-model',
        input: ['first', 'second']
    });
});

test('rejects malformed embedding responses', async () => {
    const fetchImpl = async () => Response.json({ data: [{ index: 0, embedding: [] }] });

    await assert.rejects(
        requestEmbeddings({
            provider: 'openai',
            baseUrl: 'https://inference.test',
            model: 'embed-model',
            texts: ['first'],
            fetchImpl
        }),
        /malformed or length mismatch/
    );
});

test('truncates MRL vectors client-side and L2 normalizes them', async () => {
    const fetchImpl = async () => Response.json({ data: [{ index: 0, embedding: [3, 4, 12] }] });
    const vectors = await requestEmbeddings({
        provider: 'openai',
        baseUrl: 'https://inference.test',
        model: 'embed-model',
        texts: ['first'],
        dimensions: 2,
        normalize: true,
        fetchImpl
    });

    assert.deepEqual(vectors, [[0.6, 0.8]]);
});
