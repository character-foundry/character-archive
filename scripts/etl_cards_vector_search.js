#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { MeiliSearch } from 'meilisearch';
import { initDatabase, getDatabase } from '../backend/database.js';
import { loadConfig } from '../config-loader.js';
import { readCardPngSpec, getCardFilePaths } from '../backend/utils/card-utils.js';
import {
    checkEmbeddingService,
    requestEmbeddings as requestEmbeddingVectors
} from '../backend/services/EmbeddingClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = loadConfig();
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || config.vectorSearch?.embeddingProvider || 'ollama';
const DEFAULT_EMBEDDING_URL = process.env.EMBEDDING_URL
    || config.vectorSearch?.embeddingUrl
    || process.env.OLLAMA_URL
    || config.vectorSearch?.ollamaUrl
    || 'http://127.0.0.1:11434';
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || config.vectorSearch?.embeddingApiKey || '';
const EMBED_MODEL = process.env.EMBED_MODEL || config.vectorSearch?.embedModel || 'snowflake-arctic-embed2:latest';
const EMBEDDER_NAME = process.env.MEILI_EMBEDDER || config.vectorSearch?.embedderName || 'arctic2-1024';
const EMBED_DIMENSIONS = Number(process.env.EMBED_DIMENSIONS || config.vectorSearch?.embedDimensions || 0);
const CHUNK_TOKEN_THRESHOLD = Number(process.env.CHUNK_TOKEN_THRESHOLD || 300);
const CHUNK_TARGET_CHARS = Number(process.env.CHUNK_CHAR_TARGET || 1200);
const CHUNK_CHAR_OVERLAP = Number(process.env.CHUNK_CHAR_OVERLAP || 300);
const CARD_QUERY_PAGE_SIZE = Number(process.env.CARD_QUERY_PAGE_SIZE || 100);
const LOG_EVERY = Number(process.env.LOG_EVERY || 25);
const CARD_LIMIT = process.env.LCR_VECTOR_LIMIT ? Number(process.env.LCR_VECTOR_LIMIT) : null;
const START_AFTER = process.env.LCR_VECTOR_START_AFTER ? Number(process.env.LCR_VECTOR_START_AFTER) : null;
const FORCE_REEMBED = process.env.LCR_VECTOR_FORCE === '1';
const VERIFY_DOCS = process.env.LCR_VECTOR_VERIFY === '1';
const QUEUE_MODE = process.env.LCR_VECTOR_QUEUE === '1';
const QUEUE_BATCH = process.env.LCR_VECTOR_QUEUE_BATCH ? Number(process.env.LCR_VECTOR_QUEUE_BATCH) : null;
const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 120000);
const EMBEDDING_RETRIES = Number(process.env.EMBEDDING_RETRIES || process.env.OLLAMA_RETRIES || 2);
const EMBEDDING_RETRY_BACKOFF_MS = Number(process.env.EMBEDDING_RETRY_BACKOFF_MS || process.env.OLLAMA_RETRY_BACKOFF_MS || 1000);
const EMBEDDING_SPLIT_DEPTH = Number(process.env.EMBEDDING_SPLIT_DEPTH || process.env.OLLAMA_SPLIT_DEPTH || 4);
const EMBED_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || process.env.OLLAMA_EMBED_BATCH || config.vectorSearch?.embedBatchSize || 0);
const EMBED_TOKEN_BUDGET = Math.max(256, Number(process.env.EMBEDDING_TOKEN_BUDGET || 8000));
const IDS_FILTER = process.env.LCR_VECTOR_IDS || '';
const DELETE_IDS_FILTER = process.env.LCR_VECTOR_DELETE_IDS || '';
const QUEUE_ROW_IDS_FILTER = process.env.LCR_VECTOR_QUEUE_IDS || '';
const ENABLE_CHUNK_INDEX = readBooleanFlag(process.env.MEILI_ENABLE_CHUNKS, config.vectorSearch?.enableChunks !== false);

const SECONDARY_EMBEDDING_URL = process.env.EMBEDDING_URL_SECONDARY
    || config.vectorSearch?.embeddingUrlSecondary
    || process.env.OLLAMA_URL_SECONDARY
    || config.vectorSearch?.ollamaUrlSecondary
    || null;
let embeddingInstances = [DEFAULT_EMBEDDING_URL];

let embeddingRoundRobin = 0;
const MEILI_HOST = (process.env.MEILI_HOST || config.meilisearch.host || '').replace(/\/$/, '');
const MEILI_KEY = process.env.MEILI_KEY || config.meilisearch.apiKey || '';
const CARDS_INDEX = process.env.MEILI_CARDS_INDEX || config.vectorSearch?.cardsIndex || 'cards_vsem';
const CHUNKS_INDEX = process.env.MEILI_CHUNKS_INDEX || config.vectorSearch?.chunksIndex || 'card_chunks';
const DEBUG_DUMP_DIR = process.env.VECTOR_DEBUG_DIR || null;
let debugDocCounter = 0;
let forceReembedAll = FORCE_REEMBED;
let forceChunkReembed = FORCE_REEMBED;
let verifyCardDocs = VERIFY_DOCS;
let cardsIndexClient = null;
let chunksIndexClient = null;

if (!MEILI_HOST || !MEILI_KEY) {
    console.error('[FATAL] Missing Meilisearch host or API key. Set MEILI_HOST/MEILI_KEY or config.meilisearch.');
    process.exit(1);
}

if (typeof fetch !== 'function') {
    console.error('[FATAL] Global fetch is unavailable. Run on Node.js 18+ or polyfill fetch.');
    process.exit(1);
}

const meiliClient = new MeiliSearch({ host: MEILI_HOST, apiKey: MEILI_KEY });

const jsonHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${MEILI_KEY}`
};

const stats = {
    total: 0,
    processed: 0,
    skipped: 0,
    cardUpdates: 0,
    chunkUpdates: 0,
    chunkDeletes: 0
};

const CARD_SELECT_FIELDS = [
    'id',
    'name',
    'tagline',
    'description',
    'topics',
    'tokenCount',
    'tokenDescriptionCount',
    'tokenPersonalityCount',
    'tokenScenarioCount',
    'tokenMesExampleCount',
    'tokenFirstMessageCount',
    'tokenSystemPromptCount',
    'tokenPostHistoryCount',
    'author',
    'language',
    'source',
    'sourceId',
    'sourcePath',
    'sourceUrl',
    'visibility',
    'favorited',
    'hasAlternateGreetings',
    'hasLorebook',
    'hasEmbeddedLorebook',
    'hasLinkedLorebook',
    'hasExampleDialogues',
    'hasSystemPrompt',
    'hasGallery',
    'isFuzzed',
    'lastModified',
    'createdAt',
    'nChats',
    'nMessages',
    'n_favorites',
    'starCount',
    'fullPath'
].join(', ');

function approxTokenCount(text = '') {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function normalizeText(input) {
    if (!input || typeof input !== 'string') {
        return '';
    }
    return input.replace(/\r\n/g, '\n').trim();
}

function sha256(text = '') {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function splitTopics(topics) {
    if (!topics) return [];
    if (Array.isArray(topics)) {
        return topics.map(t => t).filter(Boolean);
    }
    return String(topics)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
}

function splitArray(items, size) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }
    if (!Number.isFinite(size) || size <= 0 || size >= items.length) {
        return [items];
    }
    const batches = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

function parseIdList(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    const tokens = raw.split(/[,\s]+/).map(token => token.trim()).filter(Boolean);
    return Array.from(new Set(tokens));
}

function readBooleanFlag(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
}

function isIndexMissing(error) {
    const message = String(error?.message || '');
    return message.includes('index_not_found') || message.includes('not found');
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || String(error?.message || '').includes('aborted');
}

function isRetryableEmbeddingError(error) {
    if (isAbortError(error)) return true;
    const message = String(error?.message || '');
    return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|503|504/i.test(message);
}

function shouldSplitBatch(error) {
    const message = String(error?.message || '');
    return isAbortError(error) || /413|payload too large|request entity too large/i.test(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureIndex(indexUid, primaryKey = 'id') {
    if (!indexUid) {
        throw new Error('Missing index UID');
    }
    try {
        await meiliClient.getIndex(indexUid);
    } catch (error) {
        if (!isIndexMissing(error)) {
            throw error;
        }
        await meiliClient.createIndex(indexUid, { primaryKey });
    }
    return meiliClient.index(indexUid);
}

async function ensureEmbedderSettings(indexUid, dimensions) {
    if (!indexUid) return;
    if (!EMBEDDER_NAME) {
        console.warn('[WARN] No embedder name configured; skipping embedder settings.');
        return;
    }
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
        console.warn(`[WARN] Embed dimensions missing for ${indexUid}; skipping embedder settings.`);
        return;
    }
    const index = await ensureIndex(indexUid, 'id');
    let settings = {};
    try {
        settings = await index.getSettings();
    } catch (error) {
        console.warn(`[WARN] Failed to read settings for ${indexUid}: ${error?.message || error}`);
    }
    const embedders = settings?.embedders || {};
    const current = embedders[EMBEDDER_NAME];
    const currentDims = Number(current?.dimensions);
    if (current && Number.isFinite(currentDims) && currentDims === dimensions) {
        return;
    }
    const task = await index.updateSettings({
        embedders: {
            ...embedders,
            [EMBEDDER_NAME]: {
                source: 'userProvided',
                dimensions
            }
        }
    });
    const taskId = task?.taskUid ?? task?.uid;
    console.log(`[INFO] Scheduled embedder "${EMBEDDER_NAME}" for ${indexUid} (${dimensions}d)${taskId ? ` task ${taskId}` : ''}`);
    await waitForMeiliTask(taskId);
}

function isDocumentMissing(error) {
    const message = String(error?.message || '');
    return message.includes('document_not_found') || message.includes('not found');
}

async function cardDocHasVectors(cardId, expectedSections = []) {
    if (!cardsIndexClient) {
        return true;
    }
    try {
        const doc = await cardsIndexClient.getDocument(String(cardId), {
            fields: ['id', 'vector_sections']
        });
        const sections = Array.isArray(doc?.vector_sections) ? doc.vector_sections : [];
        if (!sections.length) {
            return false;
        }
        if (expectedSections.length) {
            const sectionSet = new Set(sections);
            for (const section of expectedSections) {
                if (!sectionSet.has(section)) {
                    return false;
                }
            }
        }
        return true;
    } catch (error) {
        if (isDocumentMissing(error)) {
            return false;
        }
        throw error;
    }
}

function collectAlternateGreetings(specData = {}, metadata = {}) {
    const candidateArrays = [
        specData.alternate_greetings,
        metadata.alternate_greetings,
        metadata.definition?.data?.alternate_greetings,
        metadata.card_data?.alternate_greetings,
        metadata.cardData?.alternate_greetings
    ];
    const seen = new Set();
    const greetings = [];
    for (const candidate of candidateArrays) {
        if (!Array.isArray(candidate)) {
            continue;
        }
        for (const entry of candidate) {
            const normalized = normalizeText(entry);
            if (!normalized || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            greetings.push(normalized);
        }
    }
    return greetings;
}

function readMetadata(cardId) {
    const { jsonPath } = getCardFilePaths(cardId);
    if (!fs.existsSync(jsonPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (error) {
        console.warn(`[WARN] Failed to read metadata JSON for ${cardId}: ${error.message}`);
        return null;
    }
}

function splitIntoChunks(text, { target = CHUNK_TARGET_CHARS, overlap = CHUNK_CHAR_OVERLAP }) {
    const cleaned = normalizeText(text);
    if (!cleaned) {
        return [];
    }
    if (cleaned.length <= target) {
        return [{ text: cleaned, start: 0 }];
    }
    const chunkCount = Math.min(4, Math.ceil(cleaned.length / target));
    const segmentSize = Math.ceil(cleaned.length / chunkCount);
    const chunks = [];
    for (let index = 0; index < chunkCount; index++) {
        const naturalStart = index * segmentSize;
        const startIndex = index === 0 ? 0 : Math.max(0, naturalStart - overlap);
        const endIndex = Math.min(cleaned.length, (index + 1) * segmentSize);
        const slice = cleaned.slice(startIndex, endIndex);
        const trimmed = slice.trim();
        const chunkStartTokens = approxTokenCount(cleaned.slice(0, startIndex));
        chunks.push({ text: trimmed, start: chunkStartTokens });
    }
    return chunks;
}

function truncateAndNormalizeVector(vector) {
    const requested = Number.isFinite(EMBED_DIMENSIONS) && EMBED_DIMENSIONS > 0
        ? Math.floor(EMBED_DIMENSIONS)
        : vector.length;
    const truncated = vector.slice(0, requested).map(value => Number(value));
    const norm = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? truncated.map(value => value / norm) : truncated;
}

async function checkEmbeddingInstance(url) {
    try {
        return await checkEmbeddingService({
            provider: EMBEDDING_PROVIDER,
            baseUrl: url,
            apiKey: EMBEDDING_API_KEY,
            signal: AbortSignal.timeout(3000)
        });
    } catch (error) {
        return false;
    }
}

async function requestEmbeddingBatch(url, texts, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const vectors = await requestEmbeddingVectors({
            provider: EMBEDDING_PROVIDER,
            baseUrl: url,
            apiKey: EMBEDDING_API_KEY,
            model: EMBED_MODEL,
            texts,
            signal: controller.signal
        });
        return vectors.map(truncateAndNormalizeVector);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function embedWithRetry(url, texts, { retries = EMBEDDING_RETRIES, timeoutMs = EMBEDDING_TIMEOUT_MS, fallbackUrl = null, depth = 0 } = {}) {
    try {
        return await requestEmbeddingBatch(url, texts, timeoutMs);
    } catch (error) {
        const message = String(error?.message || '');
        const retryable = isRetryableEmbeddingError(error);

        if (texts.length > 1 && depth < EMBEDDING_SPLIT_DEPTH && shouldSplitBatch(error)) {
            const mid = Math.ceil(texts.length / 2);
            const left = texts.slice(0, mid);
            const right = texts.slice(mid);
            console.warn(`[WARN] Embedding batch failed (${message}). Splitting ${texts.length} into ${left.length}+${right.length}`);
            const leftVectors = await embedWithRetry(url, left, { retries, timeoutMs, fallbackUrl, depth: depth + 1 });
            const rightVectors = await embedWithRetry(url, right, { retries, timeoutMs, fallbackUrl, depth: depth + 1 });
            return [...leftVectors, ...rightVectors];
        }

        if (retryable && retries > 0) {
            const attempt = EMBEDDING_RETRIES - retries + 1;
            const backoff = EMBEDDING_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
            console.warn(`[WARN] Embedding request failed (${message}). Retrying in ${backoff}ms (attempt ${attempt}/${EMBEDDING_RETRIES})`);
            await sleep(backoff);
            return embedWithRetry(url, texts, { retries: retries - 1, timeoutMs, fallbackUrl, depth });
        }

        if (fallbackUrl && fallbackUrl !== url) {
            console.warn(`[WARN] Falling back to ${fallbackUrl} for failed embedding batch: ${message}`);
            return embedWithRetry(fallbackUrl, texts, { retries: EMBEDDING_RETRIES, timeoutMs, fallbackUrl: null, depth });
        }

        throw error;
    }
}

async function embedBatch(texts) {
    if (!texts.length) {
        return [];
    }

    const embeddingUrl = embeddingInstances[embeddingRoundRobin % embeddingInstances.length];
    embeddingRoundRobin++;
    const fallbackUrl = embeddingUrl !== DEFAULT_EMBEDDING_URL ? DEFAULT_EMBEDDING_URL : null;
    return embedWithRetry(embeddingUrl, texts, { fallbackUrl });
}

async function embedBatchParallel(texts) {
    if (!texts.length) {
        return [];
    }

    if (embeddingInstances.length === 1) {
        return embedBatch(texts);
    }

    const chunkSize = Math.ceil(texts.length / embeddingInstances.length);
    const chunks = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
        chunks.push(texts.slice(i, i + chunkSize));
    }

    const promises = chunks.map(async (chunk, idx) => {
        const embeddingUrl = embeddingInstances[idx % embeddingInstances.length];
        const fallbackUrl = embeddingUrl !== DEFAULT_EMBEDDING_URL ? DEFAULT_EMBEDDING_URL : null;
        return embedWithRetry(embeddingUrl, chunk, { fallbackUrl });
    });

    const results = await Promise.all(promises);
    return results.flat();
}

async function embedTexts(texts) {
    if (!texts.length) {
        return [];
    }
    const maxBatchItems = Number.isFinite(EMBED_BATCH_SIZE) && EMBED_BATCH_SIZE > 0
        ? Math.floor(EMBED_BATCH_SIZE)
        : Number.POSITIVE_INFINITY;
    const batches = [];
    let current = [];
    let currentTokens = 0;
    for (const originalText of texts) {
        const text = approxTokenCount(originalText) > EMBED_TOKEN_BUDGET
            ? originalText.slice(0, EMBED_TOKEN_BUDGET * 4)
            : originalText;
        const tokens = Math.max(1, approxTokenCount(text));
        if (current.length && (currentTokens + tokens > EMBED_TOKEN_BUDGET || current.length >= maxBatchItems)) {
            batches.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(text);
        currentTokens += tokens;
    }
    if (current.length) batches.push(current);
    const vectors = [];
    for (const batch of batches) {
        const batchVectors = await embedBatchParallel(batch);
        vectors.push(...batchVectors);
    }
    return vectors;
}

async function meiliAddDocuments(indexUid, documents) {
    if (!documents.length) {
        return null;
    }
    if (DEBUG_DUMP_DIR && debugDocCounter < 10) {
        const dumpPath = path.join(DEBUG_DUMP_DIR, `meili-${indexUid}-${debugDocCounter}.json`);
        fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
        fs.writeFileSync(dumpPath, JSON.stringify(documents[0], null, 2));
        debugDocCounter += 1;
    }
    const url = `${MEILI_HOST}/indexes/${indexUid}/documents?primaryKey=id`;
    const response = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(documents)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[MEILI] Failed to add documents to ${indexUid}: ${response.status} ${errorText}`);
    }
    const result = await response.json();

    await waitForMeiliTask(result?.taskUid ?? result?.uid);
    return result;
}

async function waitForMeiliTask(taskUid, timeoutMs = 120000) {
    if (taskUid == null) throw new Error('[MEILI] Submission returned no task UID');
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const response = await fetch(`${MEILI_HOST}/tasks/${taskUid}`, { headers: jsonHeaders });
        if (!response.ok) throw new Error(`[MEILI] Failed to read task ${taskUid}: ${response.status}`);
        const task = await response.json();
        if (task.status === 'succeeded') return task;
        if (task.status === 'failed' || task.status === 'canceled') {
            throw new Error(`[MEILI] Task ${taskUid} ${task.status}: ${task.error?.message || 'unknown error'}`);
        }
        await sleep(250);
    }
    throw new Error(`[MEILI] Task ${taskUid} timed out after ${timeoutMs}ms`);
}

async function meiliDeleteDocuments(indexUid, ids) {
    if (!ids.length) {
        return null;
    }
    const url = `${MEILI_HOST}/indexes/${indexUid}/documents/delete-batch`;
    const response = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(ids)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[MEILI] Failed to delete documents from ${indexUid}: ${response.status} ${errorText}`);
    }
    const result = await response.json();
    await waitForMeiliTask(result?.taskUid ?? result?.uid);
    return result;
}

async function handleCard(row, db) {
    const cardId = String(row.id);
    const spec = readCardPngSpec(cardId);
    const specData = spec?.data || {};
    const metadata = readMetadata(cardId) || {};

    const sectionSources = {
        description: specData.description ?? row.description ?? metadata.description ?? '',
        personality: specData.personality ?? metadata.personality ?? '',
        scenario: specData.scenario ?? metadata.scenario ?? '',
        first_mes: specData.first_mes ?? metadata.first_mes ?? ''
    };

    const baseSections = Object.entries(sectionSources)
        .map(([section, text]) => ({ section, text: normalizeText(text) }))
        .filter(item => item.text && item.text.length > 0);
    const altGreetings = collectAlternateGreetings(specData, metadata);
    if (!baseSections.length && altGreetings.length === 0) {
        stats.skipped += 1;
        console.warn(`[WARN] No usable text sections for card ${cardId}, skipping`);
        return;
    }

    const mesExample = normalizeText(specData.mes_example ?? metadata.mes_example ?? '');

    const tags = Array.isArray(specData.tags) && specData.tags.length
        ? specData.tags
        : splitTopics(row.topics || metadata.topics);

    const language = metadata.language || row.language || 'unknown';
    const creator = specData.creator || metadata.creator || row.author || '';
    const characterVersion = specData.character_version ?? metadata.character_version ?? null;
    const extensions = specData.extensions || metadata.extensions || null;

    const dataPayload = {
        name: specData.name || metadata.name || row.name || '',
        tagline: row.tagline || metadata.tagline || '',
        description: sectionSources.description ? normalizeText(sectionSources.description) : '',
        personality: sectionSources.personality ? normalizeText(sectionSources.personality) : '',
        scenario: sectionSources.scenario ? normalizeText(sectionSources.scenario) : '',
        first_mes: sectionSources.first_mes ? normalizeText(sectionSources.first_mes) : '',
        mes_example: mesExample,
        alternate_greetings: altGreetings,
        tags,
        topics: tags,
        creator,
        character_version: characterVersion,
        extensions,
        language,
        token_counts: {
            total: row.tokenCount ?? metadata.nTokens ?? null,
            description: row.tokenDescriptionCount ?? metadata.tokenDescriptionCount ?? null,
            personality: row.tokenPersonalityCount ?? metadata.tokenPersonalityCount ?? null,
            scenario: row.tokenScenarioCount ?? metadata.tokenScenarioCount ?? null,
            mes_example: row.tokenMesExampleCount ?? metadata.tokenMesExampleCount ?? null,
            first_mes: row.tokenFirstMessageCount ?? metadata.tokenFirstMessageCount ?? null,
            system_prompt: row.tokenSystemPromptCount ?? metadata.tokenSystemPromptCount ?? null,
            post_history: row.tokenPostHistoryCount ?? metadata.tokenPostHistoryCount ?? null
        }
    };

    const meiliMetaRows = db.prepare(
        'SELECT section, chunk_index AS chunkIndex, text_sha256 AS textHash, model_name AS modelName, dims FROM card_embedding_meta WHERE cardId = ? AND embedder_name = ?'
    ).all(cardId, EMBEDDER_NAME);

    const cardMetaMap = new Map(
        meiliMetaRows
            .filter(row => Number(row.chunkIndex) === -1)
            .map(row => [`${row.section}#-1`, row])
    );

    const chunkMetaMap = new Map(
        meiliMetaRows
            .filter(row => Number(row.chunkIndex) >= 0)
            .map(row => [`${row.section}#${row.chunkIndex}`, row])
    );

    const cardSectionEntries = baseSections.flatMap(section => {
        const slices = splitIntoChunks(section.text, { target: EMBED_TOKEN_BUDGET * 4, overlap: 0 });
        return slices.map((slice, index) => ({
            section: slices.length === 1 ? section.section : `${section.section}_${index}`,
            text: slice.text,
            chunkIndex: -1,
            hash: sha256(slice.text)
        }));
    });

    const existingCardKeys = new Set(cardSectionEntries.map(entry => `${entry.section}#-1`));
    const staleCardMeta = [];
    for (const [key, rowMeta] of cardMetaMap.entries()) {
        if (!existingCardKeys.has(key)) {
            staleCardMeta.push({ section: rowMeta.section, chunkIndex: -1 });
        }
    }

    let cardNeedsUpdate = forceReembedAll || staleCardMeta.length > 0 || cardSectionEntries.some(entry => {
        const key = `${entry.section}#-1`;
        const prev = cardMetaMap.get(key);
        return !prev
            || prev.textHash !== entry.hash
            || prev.modelName !== EMBED_MODEL
            || Number(prev.dims) !== EMBED_DIMENSIONS;
    });

    const chunkSections = [];
    if (ENABLE_CHUNK_INDEX) {
        if (altGreetings.length) {
            altGreetings.forEach((greeting, idx) => {
                const slices = splitIntoChunks(greeting, { target: CHUNK_TARGET_CHARS, overlap: CHUNK_CHAR_OVERLAP });
                slices.forEach((slice, sliceIndex) => {
                    chunkSections.push({
                        section: 'alt_greeting',
                        text: slice.text,
                        approxStart: slice.start,
                        logicalIndex: `${idx}-${sliceIndex}`
                    });
                });
            });
        }

        for (const baseSection of baseSections) {
            const tokenEstimate = approxTokenCount(baseSection.text);
            if (tokenEstimate > CHUNK_TOKEN_THRESHOLD) {
                const slices = splitIntoChunks(baseSection.text, { target: CHUNK_TARGET_CHARS, overlap: CHUNK_CHAR_OVERLAP });
                slices.forEach((slice, sliceIndex) => {
                    chunkSections.push({
                        section: baseSection.section,
                        text: slice.text,
                        approxStart: slice.start,
                        logicalIndex: `${baseSection.section}-${sliceIndex}`
                    });
                });
            }
        }
    }

    const existingChunkRows = db.prepare('SELECT id, section, chunk_index AS chunkIndex FROM card_chunk_map WHERE cardId = ?').all(cardId);
    const existingChunkIds = new Set(existingChunkRows.map(row => row.id));
    const sectionCounters = new Map();
    const newChunkEntries = [];
    const chunkKeySet = new Set();

    for (const chunkSection of chunkSections) {
        const sectionKey = chunkSection.section;
        const currentIndex = sectionCounters.get(sectionKey) || 0;
        sectionCounters.set(sectionKey, currentIndex + 1);
        const chunkId = `${cardId}-${sectionKey}-${currentIndex}`;
        const hash = sha256(chunkSection.text);
        const chunkKey = `${sectionKey}#${currentIndex}`;
        chunkKeySet.add(chunkKey);
        const approxTokensStart = chunkSection.approxStart || 0;
        const chunkTokens = approxTokenCount(chunkSection.text);
        newChunkEntries.push({
            id: chunkId,
            section: sectionKey,
            chunkIndex: currentIndex,
            text: chunkSection.text,
            hash,
            startToken: approxTokensStart,
            endToken: approxTokensStart + chunkTokens
        });
    }

    const chunkIdsToDelete = Array.from(existingChunkIds).filter(id => !newChunkEntries.find(entry => entry.id === id));
    const chunkMetaRemovals = [];
    for (const [key, rowMeta] of chunkMetaMap.entries()) {
        if (!chunkKeySet.has(key)) {
            chunkMetaRemovals.push({ section: rowMeta.section, chunkIndex: rowMeta.chunkIndex });
        }
    }

    const chunkEmbedsNeeded = ENABLE_CHUNK_INDEX && forceChunkReembed
        ? newChunkEntries
        : ENABLE_CHUNK_INDEX
            ? newChunkEntries.filter(entry => {
                const key = `${entry.section}#${entry.chunkIndex}`;
                const prev = chunkMetaMap.get(key);
                return !prev
                    || prev.textHash !== entry.hash
                    || prev.modelName !== EMBED_MODEL
                    || Number(prev.dims) !== EMBED_DIMENSIONS;
            })
            : [];

    const chunkStructureChanged = chunkIdsToDelete.length > 0 || existingChunkRows.length !== newChunkEntries.length;
    const shouldProcessChunks = ENABLE_CHUNK_INDEX
        ? forceChunkReembed || chunkEmbedsNeeded.length > 0 || chunkIdsToDelete.length > 0 || chunkStructureChanged || chunkMetaRemovals.length > 0
        : chunkIdsToDelete.length > 0 || existingChunkRows.length > 0 || chunkMetaRemovals.length > 0;

    if (!cardNeedsUpdate && !shouldProcessChunks && verifyCardDocs) {
        const expectedSections = cardSectionEntries.map(entry => entry.section);
        const hasVectors = await cardDocHasVectors(cardId, expectedSections);
        if (!hasVectors) {
            cardNeedsUpdate = true;
        }
    }

    if (!cardNeedsUpdate && !shouldProcessChunks) {
        stats.skipped += 1;
        return;
    }

    if (cardNeedsUpdate) {
        const vectors = await embedTexts(cardSectionEntries.map(entry => entry.text));
        const cardDoc = {
            id: cardId,
            data: dataPayload,
            source: row.source || metadata.source || 'chub',
            sourceId: row.sourceId || metadata.sourceId || cardId,
            sourcePath: row.sourcePath || metadata.sourcePath || metadata.fullPath || row.fullPath || '',
            sourceUrl: row.sourceUrl || metadata.sourceUrl || null,
            visibility: row.visibility || metadata.visibility || 'unknown',
            favorited: row.favorited ? 1 : 0,
            rating: row.rating ?? metadata.rating ?? null,
            ratingCount: row.ratingCount ?? metadata.ratingCount ?? null,
            starCount: row.starCount ?? metadata.starCount ?? null,
            nChats: row.nChats ?? metadata.nChats ?? null,
            nMessages: row.nMessages ?? metadata.nMessages ?? null,
            tokenCount: row.tokenCount ?? metadata.nTokens ?? null,
            updatedAt: row.lastModified || metadata.lastModified || metadata.updatedAt || row.createdAt || metadata.createdAt || null,
            createdAt: row.createdAt || metadata.createdAt || null,
            vector_sections: cardSectionEntries.map(entry => entry.section)
        };
        if (vectors.length) {
            cardDoc._vectors = {
                [EMBEDDER_NAME]: {
                    embeddings: vectors,
                    regenerate: false
                }
            };
        }

        await meiliAddDocuments(CARDS_INDEX, [cardDoc]);
        stats.cardUpdates += 1;

        const insertMetaStmt = db.prepare(
            `INSERT INTO card_embedding_meta (cardId, embedder_name, model_name, dims, section, chunk_index, text_sha256, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(cardId, embedder_name, section, chunk_index)
             DO UPDATE SET text_sha256 = excluded.text_sha256, model_name = excluded.model_name, dims = excluded.dims, updated_at = CURRENT_TIMESTAMP`
        );
        for (const entry of cardSectionEntries) {
            insertMetaStmt.run(
                cardId,
                EMBEDDER_NAME,
                EMBED_MODEL,
                vectors[0]?.length || 0,
                entry.section,
                -1,
                entry.hash
            );
        }

        const deleteMetaStmt = db.prepare(
            'DELETE FROM card_embedding_meta WHERE cardId = ? AND embedder_name = ? AND section = ? AND chunk_index = ?'
        );
        for (const stale of staleCardMeta) {
            deleteMetaStmt.run(
                cardId,
                EMBEDDER_NAME,
                stale.section,
                -1
            );
        }
    }

    if (chunkIdsToDelete.length) {
        await meiliDeleteDocuments(CHUNKS_INDEX, chunkIdsToDelete);
        stats.chunkDeletes += chunkIdsToDelete.length;
        const deletePlaceholders = chunkIdsToDelete.map(() => '?').join(',');
        db.prepare(`DELETE FROM card_chunk_map WHERE id IN (${deletePlaceholders})`).run(...chunkIdsToDelete);
    }

    if (chunkEmbedsNeeded.length) {
        const vectors = await embedTexts(chunkEmbedsNeeded.map(entry => entry.text));
        const docs = chunkEmbedsNeeded.map((entry, idx) => ({
            id: entry.id,
            card_id: cardId,
            section: entry.section,
            chunk_index: entry.chunkIndex,
            text: entry.text,
            data: {
                creator,
                character_version: characterVersion,
                extensions,
                language
            },
            tags,
            source: row.source || metadata.source || 'chub',
            visibility: row.visibility || metadata.visibility || 'unknown',
            start_token: entry.startToken,
            end_token: entry.endToken,
            _vectors: {
                [EMBEDDER_NAME]: {
                    embeddings: [vectors[idx]],
                    regenerate: false
                }
            }
        }));

        await meiliAddDocuments(CHUNKS_INDEX, docs);
        stats.chunkUpdates += docs.length;

        const insertChunkMetaStmt = db.prepare(
            `INSERT INTO card_embedding_meta (cardId, embedder_name, model_name, dims, section, chunk_index, text_sha256, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(cardId, embedder_name, section, chunk_index)
             DO UPDATE SET text_sha256 = excluded.text_sha256, model_name = excluded.model_name, dims = excluded.dims, updated_at = CURRENT_TIMESTAMP`
        );
        for (const [idx, entry] of chunkEmbedsNeeded.entries()) {
            const vector = vectors[idx];
            insertChunkMetaStmt.run(
                cardId,
                EMBEDDER_NAME,
                EMBED_MODEL,
                vector.length,
                entry.section,
                entry.chunkIndex,
                entry.hash
            );
        }
    }

    const deleteChunkMetaStmt = db.prepare(
        'DELETE FROM card_embedding_meta WHERE cardId = ? AND embedder_name = ? AND section = ? AND chunk_index = ?'
    );
    for (const staleChunk of chunkMetaRemovals) {
        deleteChunkMetaStmt.run(
            cardId,
            EMBEDDER_NAME,
            staleChunk.section,
            staleChunk.chunkIndex
        );
    }

    if (shouldProcessChunks) {
        db.prepare('DELETE FROM card_chunk_map WHERE cardId = ?').run(cardId);
        const insertChunkMapStmt = db.prepare(
            `INSERT INTO card_chunk_map (id, cardId, section, chunk_index, start_token, end_token, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET section = excluded.section, chunk_index = excluded.chunk_index, start_token = excluded.start_token, end_token = excluded.end_token, updated_at = CURRENT_TIMESTAMP`
        );
        for (const entry of newChunkEntries) {
            insertChunkMapStmt.run(
                entry.id,
                cardId,
                entry.section,
                entry.chunkIndex,
                entry.startToken,
                entry.endToken
            );
        }
    }
}

async function deleteVectorDocs(cardId, db) {
    await meiliDeleteDocuments(CARDS_INDEX, [cardId]);

    const chunkIds = db.prepare('SELECT id FROM card_chunk_map WHERE cardId = ?').all(cardId).map(row => row.id);
    if (ENABLE_CHUNK_INDEX && chunkIds.length) {
        await meiliDeleteDocuments(CHUNKS_INDEX, chunkIds);
    }
}

async function processRows(rows, db, totalOverride = null) {
    const total = Number.isFinite(totalOverride) ? totalOverride : rows.length;
    for (const row of rows) {
        if (CARD_LIMIT && stats.processed >= CARD_LIMIT) {
            break;
        }
        await handleCard(row, db);
        stats.processed += 1;
        if (stats.processed % LOG_EVERY === 0) {
            console.log(`[INFO] Processed ${stats.processed}/${CARD_LIMIT || total} cards — updated cards: ${stats.cardUpdates}, chunk upserts: ${stats.chunkUpdates}, chunk deletes: ${stats.chunkDeletes}, skipped: ${stats.skipped}`);
        }
    }
}

async function processCardIds(cardIds, db) {
    const uniqueIds = Array.from(new Set(cardIds.map(id => String(id)).filter(Boolean)));
    const total = uniqueIds.length;
    if (!total) return;
    const chunkSize = 900;
    const batches = splitArray(uniqueIds, chunkSize);
    for (const batch of batches) {
        const placeholders = batch.map(() => '?').join(', ');
        const rows = db.prepare(
            `SELECT ${CARD_SELECT_FIELDS} FROM cards WHERE id IN (${placeholders}) ORDER BY id ASC`
        ).all(...batch);
        if (rows.length) {
            await processRows(rows, db, total);
        }
    }
}

function resolveQueueBatchSize() {
    if (Number.isFinite(QUEUE_BATCH) && QUEUE_BATCH > 0) {
        return Math.floor(QUEUE_BATCH);
    }
    if (Number.isFinite(CARD_LIMIT) && CARD_LIMIT > 0) {
        return Math.floor(CARD_LIMIT);
    }
    return 1000;
}

async function main() {
    console.log(`[INFO] Starting vector ETL into ${CARDS_INDEX}${ENABLE_CHUNK_INDEX ? ` / ${CHUNKS_INDEX}` : ' (chunks disabled)'}`);

    await ensureEmbedderSettings(CARDS_INDEX, EMBED_DIMENSIONS);
    cardsIndexClient = await ensureIndex(CARDS_INDEX, 'id');
    if (ENABLE_CHUNK_INDEX) {
        await ensureEmbedderSettings(CHUNKS_INDEX, EMBED_DIMENSIONS);
        chunksIndexClient = await ensureIndex(CHUNKS_INDEX, 'id');
    }

    if (SECONDARY_EMBEDDING_URL) {
        console.log(`[INFO] Checking for secondary embedding instance at ${SECONDARY_EMBEDDING_URL}...`);
        const secondaryAvailable = await checkEmbeddingInstance(SECONDARY_EMBEDDING_URL);
        if (secondaryAvailable) {
            embeddingInstances.push(SECONDARY_EMBEDDING_URL);
            console.log(`[INFO] Secondary embedding instance detected. Using ${embeddingInstances.length} instances:`);
            embeddingInstances.forEach((url, idx) => console.log(`  [${idx + 1}] ${url}`));
        } else {
            console.log(`[INFO] Secondary instance configured but not available: ${SECONDARY_EMBEDDING_URL}`);
            console.log(`[INFO] Using single instance: ${DEFAULT_EMBEDDING_URL}`);
        }
    } else {
        console.log(`[INFO] No secondary instance configured. Using single instance: ${DEFAULT_EMBEDDING_URL}`);
    }

    const explicitIds = parseIdList(IDS_FILTER);
    const deleteIds = parseIdList(DELETE_IDS_FILTER);
    const queueRowIds = parseIdList(QUEUE_ROW_IDS_FILTER);
    const needsSchema = QUEUE_MODE || explicitIds.length > 0 || deleteIds.length > 0 || queueRowIds.length > 0;

    await initDatabase({ skipSchemaMigrations: !needsSchema, skipTagRebuild: true, skipTokenBackfill: true });
    const db = getDatabase();
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM cards').get();
    stats.total = totalRow?.count || 0;

    if (QUEUE_MODE) {
        forceReembedAll = false;
        forceChunkReembed = false;
        verifyCardDocs = false;

        const batchSize = resolveQueueBatchSize();
        const queueRows = db.prepare(
            'SELECT id, cardId, action FROM vector_index_queue ORDER BY id LIMIT ?'
        ).all(batchSize);

        if (!queueRows.length) {
            console.log('[INFO] Vector queue is empty; nothing to do.');
            process.exit(0);
        }

        const actionMap = new Map();
        for (const row of queueRows) {
            const cardId = String(row.cardId);
            const action = row.action === 'delete' ? 'delete' : 'upsert';
            const existing = actionMap.get(cardId);
            if (!existing || action === 'delete') {
                actionMap.set(cardId, action);
            }
        }

        const queueDeleteIds = [];
        const queueUpsertIds = [];
        actionMap.forEach((action, cardId) => {
            if (action === 'delete') {
                queueDeleteIds.push(cardId);
            } else {
                queueUpsertIds.push(cardId);
            }
        });

        stats.total = queueDeleteIds.length + queueUpsertIds.length;

        for (const cardId of queueDeleteIds) {
            await deleteVectorDocs(cardId, db);
            stats.processed += 1;
        }

        if (queueUpsertIds.length) {
            await processCardIds(queueUpsertIds, db);
        }

        const queueIds = queueRows.map(row => row.id);
        const deletePlaceholders = queueIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM vector_index_queue WHERE id IN (${deletePlaceholders})`).run(...queueIds);

        console.log('[INFO] Vector ETL (queue) complete:', stats);
        process.exit(0);
    }

    if (deleteIds.length) {
        for (const cardId of deleteIds) {
            await deleteVectorDocs(cardId, db);
            stats.processed += 1;
        }
    }

    if (!explicitIds.length && deleteIds.length) {
        if (queueRowIds.length) {
            const deletePlaceholders = queueRowIds.map(() => '?').join(', ');
            db.prepare(`DELETE FROM vector_index_queue WHERE id IN (${deletePlaceholders})`).run(...queueRowIds);
        }
        console.log('[INFO] Vector ETL (filtered deletes) complete:', stats);
        process.exit(0);
    }

    if (explicitIds.length) {
        forceReembedAll = false;
        forceChunkReembed = false;
        verifyCardDocs = false;
        stats.total = explicitIds.length;
        await processCardIds(explicitIds, db);
        if (queueRowIds.length) {
            const deletePlaceholders = queueRowIds.map(() => '?').join(', ');
            db.prepare(`DELETE FROM vector_index_queue WHERE id IN (${deletePlaceholders})`).run(...queueRowIds);
        }
        console.log('[INFO] Vector ETL (filtered) complete:', stats);
        process.exit(0);
    }

    let cardsDocCount = null;
    let chunksDocCount = null;
    try {
        const cardsStats = await cardsIndexClient.getStats();
        cardsDocCount = typeof cardsStats?.numberOfDocuments === 'number' ? cardsStats.numberOfDocuments : null;
    } catch (error) {
        console.warn(`[WARN] Failed to read stats for ${CARDS_INDEX}: ${error?.message || error}`);
    }
    if (ENABLE_CHUNK_INDEX && chunksIndexClient) {
        try {
            const chunksStats = await chunksIndexClient.getStats();
            chunksDocCount = typeof chunksStats?.numberOfDocuments === 'number' ? chunksStats.numberOfDocuments : null;
        } catch (error) {
            console.warn(`[WARN] Failed to read stats for ${CHUNKS_INDEX}: ${error?.message || error}`);
        }
    }

    if (cardsDocCount === 0 && stats.total > 0) {
        forceReembedAll = true;
        verifyCardDocs = false;
        console.warn(`[WARN] ${CARDS_INDEX} is empty; forcing full card re-embed`);
    } else if (!forceReembedAll && Number.isFinite(cardsDocCount) && cardsDocCount < stats.total) {
        verifyCardDocs = true;
        console.warn(`[WARN] ${CARDS_INDEX} has ${cardsDocCount}/${stats.total} docs; verifying per-card vector docs`);
    }

    if (ENABLE_CHUNK_INDEX && chunksDocCount === 0 && stats.total > 0) {
        forceChunkReembed = true;
        console.warn(`[WARN] ${CHUNKS_INDEX} is empty; forcing chunk re-embed`);
    } else if (!ENABLE_CHUNK_INDEX) {
        forceChunkReembed = false;
    }

    let lastId = START_AFTER || null;
    while (true) {
        const args = [];
        let sql = `SELECT ${CARD_SELECT_FIELDS} FROM cards`;
        if (lastId !== null && lastId !== undefined) {
            sql += ' WHERE id > ?';
            args.push(lastId);
        }
        sql += ' ORDER BY id ASC LIMIT ?';
        args.push(CARD_QUERY_PAGE_SIZE);

        const rows = db.prepare(sql).all(...args);
        if (!rows.length) {
            break;
        }

        for (const row of rows) {
            if (CARD_LIMIT && stats.processed >= CARD_LIMIT) {
                break;
            }
            await handleCard(row, db);
            stats.processed += 1;
            lastId = row.id;
            if (stats.processed % LOG_EVERY === 0) {
                console.log(`[INFO] Processed ${stats.processed}/${CARD_LIMIT || stats.total} cards — updated cards: ${stats.cardUpdates}, chunk upserts: ${stats.chunkUpdates}, chunk deletes: ${stats.chunkDeletes}, skipped: ${stats.skipped}`);
            }
        }

        if (CARD_LIMIT && stats.processed >= CARD_LIMIT) {
            break;
        }
    }

    console.log('[INFO] Vector ETL complete:', stats);
    process.exit(0);
}

main().catch(error => {
    console.error('[FATAL] Vector ETL failed:', error);
    process.exit(1);
});
