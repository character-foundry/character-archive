function normalizeProvider(provider) {
    return String(provider || 'ollama').trim().toLowerCase() === 'openai' ? 'openai' : 'ollama';
}

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function buildEndpoint(provider, baseUrl, path) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
        throw new Error('Embedding service URL is missing');
    }
    if (normalizedProvider === 'openai') {
        const versionedBaseUrl = normalizedBaseUrl.endsWith('/v1')
            ? normalizedBaseUrl
            : `${normalizedBaseUrl}/v1`;
        return `${versionedBaseUrl}/${path}`;
    }
    return `${normalizedBaseUrl}/api/${path}`;
}

function buildHeaders(provider, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (normalizeProvider(provider) === 'openai' && apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}

function parseVectors(provider, payload) {
    if (normalizeProvider(provider) === 'openai') {
        if (!Array.isArray(payload?.data)) {
            return null;
        }
        return [...payload.data]
            .sort((left, right) => Number(left?.index || 0) - Number(right?.index || 0))
            .map(item => item?.embedding);
    }
    return payload?.embeddings;
}

function projectVector(vector, dimensions, normalize) {
    const requested = Number(dimensions);
    if (Number.isFinite(requested) && requested > vector.length) {
        throw new Error(`Embedding dimension mismatch: requested ${requested}, received ${vector.length}`);
    }
    const projected = Number.isFinite(requested) && requested > 0
        ? vector.slice(0, Math.floor(requested)).map(Number)
        : vector.map(Number);
    if (!normalize) return projected;
    const norm = Math.sqrt(projected.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? projected.map(value => value / norm) : projected;
}

export async function requestEmbeddings({
    provider = 'ollama',
    baseUrl,
    apiKey = '',
    model,
    texts,
    dimensions = null,
    normalize = false,
    signal,
    fetchImpl = fetch
}) {
    const normalizedProvider = normalizeProvider(provider);
    const endpoint = buildEndpoint(normalizedProvider, baseUrl, normalizedProvider === 'openai' ? 'embeddings' : 'embed');
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: buildHeaders(normalizedProvider, apiKey),
        body: JSON.stringify({ model, input: texts }),
        signal
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${normalizedProvider} embedding request failed: ${response.status} ${errorText}`);
    }
    const payload = await response.json();
    const vectors = parseVectors(normalizedProvider, payload);
    if (
        !Array.isArray(vectors)
        || vectors.length !== texts.length
        || vectors.some(vector => !Array.isArray(vector) || vector.length === 0)
    ) {
        throw new Error(`${normalizedProvider} embedding response malformed or length mismatch`);
    }
    return vectors.map(vector => projectVector(vector, dimensions, normalize));
}

export async function checkEmbeddingService({
    provider = 'ollama',
    baseUrl,
    apiKey = '',
    signal,
    fetchImpl = fetch
}) {
    const normalizedProvider = normalizeProvider(provider);
    const endpoint = buildEndpoint(normalizedProvider, baseUrl, normalizedProvider === 'openai' ? 'models' : 'tags');
    const headers = normalizedProvider === 'openai' && apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined;
    const response = await fetchImpl(endpoint, { method: 'GET', headers, signal });
    return response.ok;
}
