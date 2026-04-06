import { MeiliSearch } from 'meilisearch';
import { getDatabase } from '../database.js';
import { logger } from '../utils/logger.js';

const log = logger.scoped('SEARCH');

const FILTERABLE_FIELDS = new Set([
    'id',
    'source',
    'sourceId',
    'sourcePath',
    'name',
    'author',
    'tagline',
    'description',
    'platform_summary',
    'platformSummary',
    'tags',
    'topics',
    'type',
    'language',
    'visibility',
    'favorited',
    'hasAlternateGreetings',
    'hasLorebook',
    'hasEmbeddedLorebook',
    'hasLinkedLorebook',
    'hasExampleDialogues',
    'hasSystemPrompt',
    'hasGallery',
    'hasEmbeddedImages',
    'hasExpressions',
    'tokenCount',
    'token_count',
    'rating',
    'ratingCount',
    'starCount',
    'n_favorites',
    'favorites',
    'nChats',
    'nMessages',
    'tokenDescriptionCount',
    'tokenPersonalityCount',
    'tokenScenarioCount',
    'tokenMesExampleCount',
    'tokenFirstMessageCount',
    'tokenSystemPromptCount',
    'tokenPostHistoryCount',
    'created',
    'createdAt',
    'added',
    'updated',
    'lastModified',
    'fullPath'
]);

const SORT_MAP = {
    new: ['lastModified:desc', 'id:desc'],
    old: ['lastModified:asc', 'id:asc'],
    create_new: ['createdAt:desc', 'id:desc'],
    create_old: ['createdAt:asc', 'id:asc'],
    tokens_desc: ['tokenCount:desc', 'id:desc'],
    tokens_asc: ['tokenCount:asc', 'id:asc'],
    most_stars_desc: ['starCount:desc', 'id:desc'],
    most_stars_asc: ['starCount:asc', 'id:asc'],
    most_favs_desc: ['n_favorites:desc', 'id:desc'],
    most_favs_asc: ['n_favorites:asc', 'id:asc'],
    most_msgs_desc: ['nMessages:desc', 'id:desc'],
    most_msgs_asc: ['nMessages:asc', 'id:asc'],
    most_chats_desc: ['nChats:desc', 'id:desc'],
    most_chats_asc: ['nChats:asc', 'id:asc'],
    overall_rating_desc: ['scoreComposite:desc', 'id:desc'],
    overall_rating_asc: ['scoreComposite:asc', 'id:asc'],
    trending_desc: ['scoreVelocity:desc', 'id:desc'],
    trending_asc: ['scoreVelocity:asc', 'id:asc'],
    engagement_desc: ['engagementScore:desc', 'id:desc'],
    engagement_asc: ['engagementScore:asc', 'id:asc'],
    fresh_engagement_desc: ['engagementVelocity:desc', 'id:desc'],
    fresh_engagement_asc: ['engagementVelocity:asc', 'id:asc']
};

function computeFreshnessBonus(ageDays = 0) {
    if (ageDays <= 3) {
        return 25;
    }
    if (ageDays <= 7) {
        return 15;
    }
    if (ageDays <= 14) {
        return 8;
    }
    return 0;
}

let meiliClient = null;
let meiliIndex = null;
let meiliConfig = null;
const DEFAULT_OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_EMBED_MODEL = process.env.VECTOR_EMBED_MODEL || 'snowflake-arctic-embed2:latest';
const DEFAULT_EMBEDDER_NAME = process.env.MEILI_EMBEDDER || 'arctic2-1024';
const MS_IN_DAY = 24 * 60 * 60 * 1000;

let vectorSearchConfig = {
    enabled: false,
    enableChunks: true,
    cardsIndex: 'cards_vsem',
    chunksIndex: 'card_chunks',
    embedModel: DEFAULT_EMBED_MODEL,
    embedderName: DEFAULT_EMBEDDER_NAME,
    embedDimensions: 1024,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    semanticRatio: 0.4,
    cardsMultiplier: 2,
    maxCardHits: 400,
    chunkLimit: 80,
    chunkWeight: 0.6,
    rrfK: 60
};
let vectorIndexReady = false;
let vectorIndexSetupPromise = null;
let chunkIndexHasDocs = true;

function chunksAreEnabled(config = vectorSearchConfig) {
    return config?.enableChunks !== false && Boolean((config?.chunksIndex || '').trim());
}

function getConfiguredChunkIndexUid(config = vectorSearchConfig) {
    return chunksAreEnabled(config) ? (config?.chunksIndex || '').trim() : '';
}

export function configureSearchIndex(config = {}) {
    if (!config || config.enabled !== true) {
        meiliClient = null;
        meiliIndex = null;
        meiliConfig = null;
        return false;
    }

    const host = (config.host || '').trim();
    if (!host) {
        log.warn('Meilisearch host is not configured');
        return false;
    }

    try {
        meiliClient = new MeiliSearch({ host, apiKey: config.apiKey || undefined });
        const indexName = (config.indexName || 'cards').trim() || 'cards';
        meiliIndex = meiliClient.index(indexName);
        meiliConfig = { ...config, indexName };
        log.info(`Meilisearch enabled for index "${indexName}"`);
        return true;
    } catch (error) {
        log.error('Failed to initialize Meilisearch', error);
        meiliClient = null;
        meiliIndex = null;
        meiliConfig = null;
        return false;
    }
}

export function configureVectorSearch(config = {}) {
    const sanitized = { ...vectorSearchConfig };
    if (typeof config.enabled === 'boolean') sanitized.enabled = config.enabled;
    if (typeof config.enableChunks === 'boolean') sanitized.enableChunks = config.enableChunks;
    if (typeof config.cardsIndex === 'string' && config.cardsIndex.trim()) {
        sanitized.cardsIndex = config.cardsIndex.trim();
    }
    if (typeof config.chunksIndex === 'string' && config.chunksIndex.trim()) {
        sanitized.chunksIndex = config.chunksIndex.trim();
    }
    if (typeof config.embedModel === 'string' && config.embedModel.trim()) {
        sanitized.embedModel = config.embedModel.trim();
    }
    if (typeof config.embedderName === 'string' && config.embedderName.trim()) {
        sanitized.embedderName = config.embedderName.trim();
    }
    if (typeof config.embedDimensions === 'number' && Number.isFinite(config.embedDimensions) && config.embedDimensions > 0) {
        sanitized.embedDimensions = Math.floor(config.embedDimensions);
    }
    if (typeof config.ollamaUrl === 'string' && config.ollamaUrl.trim()) {
        sanitized.ollamaUrl = config.ollamaUrl.replace(/\/$/, '');
    }
    if (typeof config.semanticRatio === 'number' && Number.isFinite(config.semanticRatio)) {
        sanitized.semanticRatio = Math.min(1, Math.max(0, config.semanticRatio));
    }
    if (typeof config.cardsMultiplier === 'number' && Number.isFinite(config.cardsMultiplier)) {
        sanitized.cardsMultiplier = Math.max(1, config.cardsMultiplier);
    }
    if (typeof config.maxCardHits === 'number' && Number.isFinite(config.maxCardHits)) {
        sanitized.maxCardHits = Math.max(50, Math.min(1000, Math.floor(config.maxCardHits)));
    }
    if (typeof config.chunkLimit === 'number' && Number.isFinite(config.chunkLimit)) {
        sanitized.chunkLimit = Math.max(20, Math.min(200, Math.floor(config.chunkLimit)));
    }
    if (typeof config.chunkWeight === 'number' && Number.isFinite(config.chunkWeight)) {
        sanitized.chunkWeight = Math.max(0, config.chunkWeight);
    }
    if (typeof config.rrfK === 'number' && Number.isFinite(config.rrfK)) {
        sanitized.rrfK = Math.max(1, Math.floor(config.rrfK));
    }

    vectorSearchConfig = sanitized;
    vectorIndexReady = false;
    chunkIndexHasDocs = chunksAreEnabled(sanitized);
    if (vectorSearchConfig.enabled) {
        if (chunksAreEnabled(vectorSearchConfig)) {
            log.info(`Vector search configured (cards=${vectorSearchConfig.cardsIndex}, chunks=${vectorSearchConfig.chunksIndex})`);
        } else {
            log.info(`Vector search configured (cards=${vectorSearchConfig.cardsIndex}, chunks=disabled)`);
        }
    }
    return vectorSearchConfig.enabled;
}

export function isVectorSearchReady() {
    return Boolean(vectorSearchConfig.enabled && meiliClient);
}

export function isSearchIndexEnabled() {
    return Boolean(meiliIndex);
}

export function getMeilisearchContext() {
    return {
        client: meiliClient,
        index: meiliIndex,
        config: meiliConfig
    };
}

function ensureMeiliEnabled() {
    if (!meiliIndex) {
        throw new Error('Meilisearch is not enabled');
    }
    return meiliIndex;
}

export async function purgeVectorChunkArtifacts({ deleteIndex = true } = {}) {
    const database = getDatabase();
    if (!database) {
        throw new Error('Database is not initialized');
    }

    const chunksIndexUid = (vectorSearchConfig.chunksIndex || '').trim();
    let deletedIndex = false;
    if (deleteIndex && meiliClient && chunksIndexUid) {
        try {
            const task = await meiliClient.deleteIndex(chunksIndexUid);
            await waitForIndexTask(null, task, { label: `Delete chunk index (${chunksIndexUid})` });
            deletedIndex = true;
        } catch (error) {
            const message = String(error?.message || '');
            if (!message.includes('index_not_found') && !message.includes('not found')) {
                throw error;
            }
            log.info(`Chunk index "${chunksIndexUid}" already absent`);
        }
    }

    const chunkMapResult = database.prepare('DELETE FROM card_chunk_map').run();
    const chunkMetaResult = database.prepare('DELETE FROM card_embedding_meta WHERE chunk_index >= 0').run();

    chunkIndexHasDocs = false;
    resetVectorIndexState('chunk-artifacts-purged');

    const summary = {
        deletedIndex,
        clearedChunkMapRows: chunkMapResult.changes || 0,
        clearedChunkMetaRows: chunkMetaResult.changes || 0
    };
    log.info('Purged vector chunk artifacts', summary);
    return summary;
}

export async function ensureVectorEmbedders() {
    if (!vectorSearchConfig.enabled) {
        return false;
    }
    if (!meiliClient) {
        log.warn('Cannot ensure vector embedders: Meilisearch client is not configured');
        return false;
    }
    if (!vectorSearchConfig.embedderName) {
        log.warn('Cannot ensure vector embedders: embedderName is not configured');
        return false;
    }
    const dimensions = Number(vectorSearchConfig.embedDimensions);
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
        log.warn('Cannot ensure vector embedders: embedDimensions is not configured');
        return false;
    }
    const indexUids = [vectorSearchConfig.cardsIndex, getConfiguredChunkIndexUid()]
        .map(uid => (uid || '').trim())
        .filter(Boolean);
    if (!indexUids.length) {
        log.warn('Cannot ensure vector embedders: no vector indexes configured');
        return false;
    }

    for (const uid of indexUids) {
        const index = await ensureVectorIndex(uid, 'id');
        let settings = {};
        try {
            settings = await index.getSettings();
        } catch (error) {
            log.warn(`Failed to read settings for index "${uid}"`, error);
        }
        const embedders = settings?.embedders || {};
        const currentEmbedder = embedders[vectorSearchConfig.embedderName];
        const currentDimensions = Number(currentEmbedder?.dimensions);
        if (currentEmbedder && Number.isFinite(currentDimensions) && currentDimensions === dimensions) {
            continue;
        }
        const pending = await hasPendingSettingsUpdate(uid);
        if (pending) {
            log.warn(`Embedder settings update already pending for index "${uid}"`);
            continue;
        }
        const task = await index.updateSettings({
            embedders: {
                ...embedders,
                [vectorSearchConfig.embedderName]: {
                    source: 'userProvided',
                    dimensions
                }
            }
        });
        await waitForIndexTask(index, task, { label: `Meili settings (${uid})` });
        log.info(`Updated embedder settings for index "${uid}" (${vectorSearchConfig.embedderName}, ${dimensions})`);
    }

    return true;
}

async function applyDefaultSettings() {
    if (!meiliIndex) {
        return;
    }
    await meiliIndex.updateSettings({
        searchableAttributes: SEARCHABLE_FIELDS,
        filterableAttributes: FILTERABLE_ATTRIBUTES,
        sortableAttributes: getSortAttributes(),
        displayedAttributes: ['*'],
        typoTolerance: {
            minWordSizeForTypos: {
                oneTypo: 4,
                twoTypos: 8
            }
        }
    });
}

export function buildSearchDocumentFromRow(row) {
    if (!row) return null;
    const topics = row.topics
        ? row.topics.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean)
        : [];
    const starCount = Number(row.starCount) || 0;
    const favoritesCount = Number(row.n_favorites) || 0;
    const chatCount = Number(row.nChats) || 0;
    const messageCount = Number(row.nMessages) || 0;
    const ratingValue = Number(row.rating) || 0;
    const ratingVotes = Number(row.ratingCount) || 0;

    const scoreComposite = (starCount * 1) + (favoritesCount * 2);
    const createdTime = row.createdAt || null;
    const updatedTime = row.lastModified || null;
    let scoreVelocity = scoreComposite;
    let createdAgeDays = 1;
    if (createdTime) {
        const created = new Date(createdTime.replace(' ', 'T'));
        createdAgeDays = Math.max(1, (Date.now() - created.getTime()) / MS_IN_DAY);
        scoreVelocity = scoreComposite / createdAgeDays;
    }

    const lastActivityTime = updatedTime || createdTime;
    let activityAgeDays = createdAgeDays;
    if (lastActivityTime) {
        const activity = new Date(lastActivityTime.replace(' ', 'T'));
        activityAgeDays = Math.max(1, (Date.now() - activity.getTime()) / MS_IN_DAY);
    }

    const ratingDelta = Math.max(0, ratingValue - 3);
    const ratingContribution = ratingDelta * ratingVotes * 0.2;
    const engagementScore = (chatCount * 1.5) + (messageCount * 0.1) + (favoritesCount * 2) + (starCount * 0.5) + ratingContribution + computeFreshnessBonus(activityAgeDays);
    const engagementVelocity = engagementScore / activityAgeDays;

    return {
        id: String(row.id),
        name: row.name || '',
        tagline: row.tagline || '',
        description: row.description || '',
        platform_summary: row.description || '',
        author: row.author || '',
        source: row.source || 'chub',
        sourceId: row.sourceId || String(row.id),
        sourcePath: row.sourcePath || '',
        sourceSpecific: row.sourcePath || '',
        fullPath: row.fullPath || row.sourcePath || '',
        tags: topics,
        topics,
        type: 'character',
        language: row.language || 'unknown',
        visibility: row.visibility || 'unknown',
        favorited: row.favorited ? 1 : 0,
        favoritedBool: Boolean(row.favorited),
        hasAlternateGreetings: Boolean(row.hasAlternateGreetings),
        hasLorebook: Boolean(row.hasLorebook),
        hasEmbeddedLorebook: Boolean(row.hasEmbeddedLorebook),
        hasLinkedLorebook: Boolean(row.hasLinkedLorebook),
        hasExampleDialogues: Boolean(row.hasExampleDialogues),
        hasSystemPrompt: Boolean(row.hasSystemPrompt),
        hasGallery: Boolean(row.hasGallery),
        hasEmbeddedImages: Boolean(row.hasEmbeddedImages),
        hasExpressions: Boolean(row.hasExpressions),
        tokenCount: Number(row.tokenCount) || 0,
        token_count: Number(row.tokenCount) || 0,
        tokenDescriptionCount: Number(row.tokenDescriptionCount) || 0,
        tokenPersonalityCount: Number(row.tokenPersonalityCount) || 0,
        tokenScenarioCount: Number(row.tokenScenarioCount) || 0,
        tokenMesExampleCount: Number(row.tokenMesExampleCount) || 0,
        tokenFirstMessageCount: Number(row.tokenFirstMessageCount) || 0,
        tokenSystemPromptCount: Number(row.tokenSystemPromptCount) || 0,
        tokenPostHistoryCount: Number(row.tokenPostHistoryCount) || 0,
        rating: ratingValue,
        ratingCount: ratingVotes,
        starCount,
        n_favorites: favoritesCount,
        favorites: favoritesCount,
        nChats: chatCount,
        nMessages: messageCount,
        created: createdTime,
        createdAt: createdTime,
        added: createdTime,
        updated: updatedTime,
        lastModified: updatedTime,
        scoreComposite,
        scoreVelocity,
        engagementScore,
        engagementVelocity
    };
}

export function normalizeFilterExpression(rawFilter = '') {
    if (!rawFilter || typeof rawFilter !== 'string') {
        return '';
    }

    const replaced = rawFilter.replace(/(\b[a-zA-Z_][\w]*)\s*:\s*("[^"]*"|'[^']*'|[^\s()]+)/g, (match, field, value) => {
        if (!FILTERABLE_FIELDS.has(field)) {
            return match;
        }
        let normalizedValue = value;
        if (!(value.startsWith('"') && value.endsWith('"')) && !(value.startsWith('"') && value.endsWith('"'))) {
            const isNumber = /^-?\d+(?:\.\d+)?$/.test(value);
            const isBoolean = /^(true|false)$/i.test(value);
            if (!isNumber && !isBoolean) {
                normalizedValue = `"${value}"`;
            }
        }
        return `${field} = ${normalizedValue}`;
    });

    return replaced.trim();
}

export async function indexDocuments(documents = []) {
    if (!meiliIndex || !Array.isArray(documents) || documents.length === 0) {
        return;
    }
    await meiliIndex.addDocuments(documents);
}

export async function deleteDocumentsByIds(ids = []) {
    if (!meiliIndex || !Array.isArray(ids) || ids.length === 0) {
        return;
    }
    await meiliIndex.deleteDocuments(ids.map(id => String(id)));
}

function parseFederatedQueryPhrases(input = '') {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) {
        return { phrases: [], usedOr: false };
    }

    const normalized = trimOuterParens(raw);
    try {
        const tokens = tokenizeBooleanExpression(normalized);
        const ast = parseBooleanExpression(tokens);
        if (!ast) {
            return { phrases: normalized ? [normalized] : [], usedOr: false };
        }
        const conjunctions = expandBooleanExpression(ast);
        const normalizedPhrases = conjunctions
            .map(parts => parts.map(part => part.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        const deduped = Array.from(new Set(normalizedPhrases));
        if (deduped.length === 0) {
            return { phrases: normalized ? [normalized] : [], usedOr: false };
        }
        return { phrases: deduped, usedOr: deduped.length > 1 };
    } catch (error) {
        return { phrases: normalized ? [normalized] : [], usedOr: false };
    }
}

function trimOuterParens(value = '') {
    let result = value.trim();
    while (result.startsWith('(') && result.endsWith(')')) {
        const inner = result.slice(1, -1).trim();
        if (!inner || !hasBalancedParens(inner)) {
            break;
        }
        result = inner;
    }
    return result;
}

function hasBalancedParens(value = '') {
    let depth = 0;
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (char === '(') depth += 1;
        if (char === ')') {
            depth -= 1;
            if (depth < 0) return false;
        }
    }
    return depth === 0;
}

function tokenizeBooleanExpression(value = '') {
    const tokens = [];
    let buffer = '';
    let inQuote = false;
    let quoteChar = '';

    const pushBuffer = () => {
        const normalized = buffer.trim().replace(/\s+/g, ' ');
        if (normalized) {
            tokens.push({ type: 'literal', value: normalized });
        }
        buffer = '';
    };

    const matchesOperator = (index, op) => {
        const slice = value.slice(index, index + op.length);
        if (slice !== op) return false;
        const before = index === 0 ? '' : value[index - 1];
        const after = value[index + op.length] || '';
        const beforeBoundary = !before || /["\s()]/ .test(before);
        const afterBoundary = !after || /["\s()]/ .test(after);
        return beforeBoundary && afterBoundary;
    };

    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        const prevChar = i > 0 ? value[i - 1] : '';

        if (inQuote) {
            buffer += char;
            if (char === quoteChar && prevChar !== '\\') {
                inQuote = false;
                quoteChar = '';
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inQuote = true;
            quoteChar = char;
            buffer += char;
            continue;
        }

        if (char === '(' || char === ')') {
            pushBuffer();
            tokens.push({ type: 'paren', value: char });
            continue;
        }

        if (matchesOperator(i, 'AND')) {
            pushBuffer();
            tokens.push({ type: 'op', value: 'AND' });
            i += 2;
            continue;
        }

        if (matchesOperator(i, 'OR')) {
            pushBuffer();
            tokens.push({ type: 'op', value: 'OR' });
            i += 1;
            continue;
        }

        if (matchesOperator(i, 'NOT')) {
            pushBuffer();
            tokens.push({ type: 'op', value: 'NOT' });
            i += 2;
            continue;
        }

        buffer += char;
    }

    pushBuffer();
    return tokens;
}

function parseBooleanExpression(tokens = []) {
    let index = 0;

    const peek = () => tokens[index];
    const consume = () => tokens[index++];

    const parseExpression = () => parseOr();

    const parseOr = () => {
        let node = parseAnd();
        while (peek()?.type === 'op' && peek().value === 'OR') {
            consume();
            const right = parseAnd();
            node = { type: 'or', left: node, right };
        }
        return node;
    };

    const parseAnd = () => {
        let node = parseUnary();
        while (peek()?.type === 'op' && peek().value === 'AND') {
            consume();
            const right = parseUnary();
            node = { type: 'and', left: node, right };
        }
        return node;
    };

    const parseUnary = () => {
        const token = peek();
        if (!token) {
            return null;
        }
        if (token.type === 'op' && token.value === 'NOT') {
            consume();
            const child = parseUnary();
            return { type: 'not', child };
        }
        if (token.type === 'paren' && token.value === '(') {
            consume();
            const inner = parseExpression();
            if (peek()?.type === 'paren' && peek().value === ')') {
                consume();
            }
            return inner;
        }
        if (token.type === 'literal') {
            consume();
            return { type: 'literal', value: token.value };
        }
        return null;
    };

    return parseExpression();
}

function expandBooleanExpression(node) {
    if (!node) {
        return [];
    }
    switch (node.type) {
        case 'literal':
            return [[node.value]];
        case 'not':
            return expandBooleanExpression(node.child).map(parts => [`NOT (${parts.join(' ')})`]);
        case 'and':
            return combineConjunctions(
                expandBooleanExpression(node.left),
                expandBooleanExpression(node.right)
            );
        case 'or':
            return [
                ...expandBooleanExpression(node.left),
                ...expandBooleanExpression(node.right)
            ];
        default:
            return [];
    }
}

function combineConjunctions(left = [], right = []) {
    if (!left.length) return right;
    if (!right.length) return left;
    const combos = [];
    left.forEach(l => {
        right.forEach(r => {
            combos.push([...l, ...r]);
        });
    });
    return combos;
}

function resolveIndexUid() {
    if (meiliConfig?.indexName) {
        return meiliConfig.indexName;
    }
    if (meiliIndex?.uid) {
        return meiliIndex.uid;
    }
    return 'cards';
}

async function runFederatedMultiSearch({
    phrases,
    filter,
    limit,
    offset,
    sort
} = {}) {
    try {
        return await executeFederatedMultiSearch({
            phrases,
            filter,
            limit,
            offset,
            sort
        });
    } catch (error) {
        if (isFederationSortUnsupported(error)) {
            log.warn('Federation sort unsupported, falling back to manual OR search');
            return runManualMultiOrSearch({
                phrases,
                filter,
                limit,
                offset,
                sort
            });
        }
        throw error;
    }
}

async function executeFederatedMultiSearch({
    phrases,
    filter,
    limit,
    offset,
    sort
} = {}) {
    if (!meiliClient) {
        throw new Error('Meilisearch client is not initialized');
    }

    const sanitizedLimit = Math.max(1, Math.min(Number(limit) || 1, 100));
    const sanitizedOffset = Math.max(0, Number(offset) || 0);
    const indexUid = resolveIndexUid();

    const queries = Array.isArray(phrases)
        ? phrases
            .map(phrase => (typeof phrase === 'string' ? phrase.trim() : ''))
            .filter(Boolean)
            .map(phrase => {
                const queryPayload = {
                    indexUid,
                    q: phrase
                };
                if (filter) {
                    queryPayload.filter = filter;
                }
                if (Array.isArray(sort) && sort.length > 0) {
                    queryPayload.sort = sort;
                }
                return queryPayload;
            })
        : [];

    if (queries.length === 0) {
        return {
            ids: [],
            total: 0,
            raw: null
        };
    }

    const federation = {
        limit: sanitizedLimit,
        offset: sanitizedOffset
    };

    const response = await meiliClient.multiSearch({
        federation,
        queries
    });

    const { hits, total } = extractFederatedHits(response);
    const ids = hits
        .map(hit => (hit && typeof hit.id !== 'undefined' ? String(hit.id) : null))
        .filter(Boolean);

    return {
        ids,
        total,
        raw: response
    };
}

async function runManualMultiOrSearch({
    phrases,
    filter,
    limit,
    offset,
    sort
} = {}) {
    ensureMeiliEnabled();

    const sanitizedLimit = Math.max(1, Math.min(Number(limit) || 1, 100));
    const sanitizedOffset = Math.max(0, Number(offset) || 0);
    const perQueryLimit = Math.min(1000, sanitizedOffset + sanitizedLimit + 100);

    const baseOptions = {
        limit: perQueryLimit,
        offset: 0
    };

    if (filter) {
        baseOptions.filter = filter;
    }
    if (Array.isArray(sort) && sort.length > 0) {
        baseOptions.sort = sort;
    }

    const hitMap = new Map();

    for (const phrase of phrases) {
        const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
        if (!trimmed) continue;
        const result = await meiliIndex.search(trimmed, baseOptions);
        const hits = Array.isArray(result?.hits) ? result.hits : [];
        hits.forEach(hit => {
            if (!hit || typeof hit.id === 'undefined') return;
            const key = String(hit.id);
            if (!hitMap.has(key)) {
                hitMap.set(key, hit);
            }
        });
    }

    let combinedHits = Array.from(hitMap.values());
    if (Array.isArray(sort) && sort.length > 0) {
        combinedHits = combinedHits.sort((a, b) => compareHitsBySortRules(a, b, sort));
    }

    const total = combinedHits.length;
    const paginatedHits = combinedHits.slice(sanitizedOffset, sanitizedOffset + sanitizedLimit);
    const ids = paginatedHits.map(hit => String(hit.id));

    return {
        ids,
        total,
        raw: {
            hits: paginatedHits,
            estimatedTotalHits: total,
            fallback: 'manual-or'
        }
    };
}

function extractFederatedHits(response) {
    if (response?.federation?.hits) {
        const hits = Array.isArray(response.federation.hits) ? response.federation.hits : [];
        const total = typeof response.federation.estimatedTotalHits === 'number'
            ? response.federation.estimatedTotalHits
            : (typeof response.federation.totalHits === 'number' ? response.federation.totalHits : hits.length);
        return { hits, total };
    }

    const hits = Array.isArray(response?.hits) ? response.hits : [];
    const total = typeof response?.estimatedTotalHits === 'number'
        ? response.estimatedTotalHits
        : (typeof response?.totalHits === 'number' ? response.totalHits : hits.length);
    return { hits, total };
}

function isFederationSortUnsupported(error) {
    const message = typeof error?.message === 'string'
        ? error.message
        : (typeof error === 'string' ? error : '');
    return message.includes('Unknown field `sort` inside `.federation`');
}

function compareHitsBySortRules(hitA = {}, hitB = {}, sortRules = []) {
    if (!Array.isArray(sortRules) || sortRules.length === 0) {
        return 0;
    }

    for (const rule of sortRules) {
        if (!rule || typeof rule !== 'string') {
            continue;
        }
        const [field, directionRaw] = rule.split(':');
        if (!field) {
            continue;
        }
        const direction = (directionRaw || 'asc').toLowerCase() === 'desc' ? -1 : 1;
        const valueA = normalizeSortableValue(hitA[field]);
        const valueB = normalizeSortableValue(hitB[field]);

        if (valueA === valueB) {
            continue;
        }

        if (valueA === null || typeof valueA === 'undefined') {
            if (valueB === null || typeof valueB === 'undefined') {
                continue;
            }
            return 1;
        }
        if (valueB === null || typeof valueB === 'undefined') {
            return -1;
        }

        if (typeof valueA === 'string' && typeof valueB === 'string') {
            const comparison = valueA.localeCompare(valueB);
            if (comparison !== 0) {
                return comparison * direction;
            }
            continue;
        }

        if (valueA < valueB) {
            return -1 * direction;
        }
        if (valueA > valueB) {
            return 1 * direction;
        }
    }

    return 0;
}

function normalizeSortableValue(value) {
    if (value === null || typeof value === 'undefined') {
        return null;
    }

    if (typeof value === 'number') {
        return value;
    }

    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }

    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === 'string') {
        const numeric = Number(value);
        if (!Number.isNaN(numeric) && value.trim() !== '') {
            return numeric;
        }
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
            return timestamp;
        }
        return value.toLowerCase();
    }

    return value;
}

export async function searchMeilisearchCards({
    text = '',
    filter = '',
    page = 1,
    limit = 48,
    sort = 'new'
} = {}) {
    ensureMeiliEnabled();

    const normalizedFilter = normalizeFilterExpression(filter);
    const hitsPerPage = Math.max(1, Math.min(limit, 100));
    const pageNumber = Math.max(1, page);
    const sortRules = typeof sort === 'string' ? (SORT_MAP[sort] || SORT_MAP.new) : null;
    const offset = (pageNumber - 1) * hitsPerPage;

    const { phrases, usedOr } = parseFederatedQueryPhrases(text);
    const normalizedText = phrases.length > 0
        ? phrases[0]
        : (typeof text === 'string' ? text.trim() : '');
    const shouldFederate = usedOr && phrases.length > 1;

    if (shouldFederate) {
        const federatedResult = await runFederatedMultiSearch({
            phrases,
            filter: normalizedFilter,
            limit: hitsPerPage,
            offset,
            sort: sortRules
        });

        return {
            ...federatedResult,
            appliedFilter: normalizedFilter
        };
    }

    const searchParams = {
        q: normalizedText || '',
        page: pageNumber,
        hitsPerPage
    };

    if (Array.isArray(sortRules) && sortRules.length > 0) {
        searchParams.sort = sortRules;
    }

    if (normalizedFilter) {
        searchParams.filter = normalizedFilter;
    }

    const result = await meiliIndex.search(searchParams.q, searchParams);
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    const ids = hits.map(hit => String(hit.id));
    const total = typeof result?.estimatedTotalHits === 'number'
        ? result.estimatedTotalHits
        : (typeof result?.totalHits === 'number' ? result.totalHits : hits.length);

    return {
        ids,
        total,
        raw: result,
        appliedFilter: normalizedFilter
    };
}

function ensureVectorClient() {
    if (!isVectorSearchReady()) {
        throw new Error('Vector search is not enabled');
    }
}

function isMissingEmbedderError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Cannot find embedder');
}

function resetVectorIndexState(reason = '') {
    vectorIndexReady = false;
    vectorIndexSetupPromise = null;
    if (reason) {
        log.warn(`Vector index state reset (${reason})`);
    }
}

async function hasPendingSettingsUpdate(indexUid) {
    if (!meiliClient?.tasks || typeof meiliClient.tasks.getTasks !== 'function') {
        return false;
    }
    const uid = (indexUid || '').trim();
    if (!uid) return false;
    try {
        const tasks = await meiliClient.tasks.getTasks({
            indexUids: [uid],
            types: ['settingsUpdate'],
            statuses: ['enqueued', 'processing'],
            limit: 1
        });
        const results = Array.isArray(tasks?.results) ? tasks.results : [];
        return results.length > 0;
    } catch (error) {
        log.warn('Failed to check Meilisearch task queue', error);
        return false;
    }
}

async function fetchQueryEmbedding(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
        throw new Error('Vector search requires a query string');
    }
    const body = JSON.stringify({
        model: vectorSearchConfig.embedModel,
        input: [trimmed]
    });
    const response = await fetch(`${vectorSearchConfig.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embed failed: ${response.status} ${errorText}`);
    }
    const payload = await response.json();
    const embedding = Array.isArray(payload?.embeddings?.[0]) ? payload.embeddings[0] : null;
    if (!embedding || !embedding.length) {
        throw new Error('Received empty embedding from Ollama');
    }
    return embedding;
}

function getVectorIndex(uid) {
    if (!meiliClient) {
        return null;
    }
    const trimmed = (uid || '').trim();
    if (!trimmed) {
        return null;
    }
    return meiliClient.index(trimmed);
}

async function ensureVectorIndex(uid, primaryKey = 'id') {
    if (!meiliClient) {
        throw new Error('Meilisearch client is not configured');
    }
    const trimmed = (uid || '').trim();
    if (!trimmed) {
        throw new Error('Vector index UID is not configured');
    }
    try {
        const indexInfo = await meiliClient.getIndex(trimmed);
        if (!indexInfo?.primaryKey && primaryKey) {
            log.info(`Setting primary key "${primaryKey}" on index "${trimmed}"`);
            const task = await meiliClient.updateIndex(trimmed, { primaryKey });
            await waitForIndexTask(null, task);
        }
        return meiliClient.index(trimmed);
    } catch (error) {
        const message = error?.message || '';
        if (message.includes('index_not_found') || message.includes('not found')) {
            log.info(`Creating Meilisearch index "${trimmed}" (primaryKey=${primaryKey})`);
            const task = await meiliClient.createIndex(trimmed, { primaryKey });
            await waitForIndexTask(null, task);
            return meiliClient.index(trimmed);
        }
        throw error;
    }
}

function resolveEmbedDimensions(observedLength = null) {
    const configured = Number(vectorSearchConfig.embedDimensions);
    if (Number.isFinite(configured) && configured > 0) {
        if (observedLength && configured !== observedLength) {
            log.warn(`vectorSearch.embedDimensions (${configured}) does not match embed length (${observedLength}). Using observed length.`);
            vectorSearchConfig.embedDimensions = observedLength;
            return observedLength;
        }
        return configured;
    }
    if (observedLength && observedLength > 0) {
        vectorSearchConfig.embedDimensions = observedLength;
        return observedLength;
    }
    return null;
}

async function waitForIndexTask(index, task, { timeoutMs = 60000, allowFallback = true, label = 'Meili task' } = {}) {
    if (!task) return true;
    const taskUid = task?.taskUid ?? task?.uid;
    if (!taskUid) return true;
    const waitOpts = { timeOutMs: timeoutMs };
    if (meiliClient?.tasks && typeof meiliClient.tasks.getTask === 'function') {
        const start = Date.now();
        let lastLog = 0;
        while (true) {
            const taskStatus = await meiliClient.tasks.getTask(taskUid);
            const status = taskStatus?.status || 'unknown';
            const elapsedSec = Math.floor((Date.now() - start) / 1000);
            if (Date.now() - lastLog > 5000) {
                log.info(`${label} ${taskUid} status=${status} elapsed=${elapsedSec}s`);
                lastLog = Date.now();
            }
            if (status !== 'enqueued' && status !== 'processing') {
                return true;
            }
            if (Date.now() - start > timeoutMs) {
                log.warn(`Timed out waiting for Meilisearch task ${taskUid} (status=${status})`);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (index && typeof index.waitForTask === 'function') {
        try {
            await index.waitForTask(taskUid, waitOpts);
            return true;
        } catch (error) {
            if (!allowFallback) {
                log.warn('Failed waiting for Meilisearch task', error);
                return false;
            }
            // fall through to global wait
        }
    }
    if (meiliClient && typeof meiliClient.waitForTask === 'function') {
        try {
            await meiliClient.waitForTask(taskUid, waitOpts);
            return true;
        } catch (error) {
            log.warn('Failed waiting for Meilisearch task', error);
            return false;
        }
    }
    return true;
}

async function ensureVectorIndexesReady(observedLength, options = {}) {
    if (vectorIndexReady) {
        return;
    }
    if (!vectorSearchConfig.embedderName) {
        throw new Error('Vector search embedderName is not configured');
    }
    const dimensions = resolveEmbedDimensions(observedLength);
    if (!dimensions) {
        throw new Error('Unable to determine embedding dimensions; set vectorSearch.embedDimensions.');
    }
    if (!meiliClient) {
        throw new Error('Meilisearch client is not configured');
    }
    const waitTimeoutMs = Number.isFinite(options.waitTimeoutMs) ? options.waitTimeoutMs : 60000;
    const allowPending = options.allowPending === true;
    const allowFallbackWait = options.allowFallbackWait !== false;
    if (vectorIndexSetupPromise) {
        return vectorIndexSetupPromise;
    }
    vectorIndexSetupPromise = (async () => {
        const indexDefinitions = [
            {
                uid: vectorSearchConfig.cardsIndex,
                primaryKey: 'id',
                filterables: Array.from(FILTERABLE_FIELDS),
                distinct: null
            },
            ...(chunksAreEnabled()
                ? [{
                    uid: vectorSearchConfig.chunksIndex,
                    primaryKey: 'id',
                    filterables: VECTOR_CHUNK_FILTERABLES,
                    distinct: VECTOR_CHUNK_DISTINCT_ATTRIBUTE
                }]
                : [])
        ].filter(def => (def.uid || '').trim());
        if (!indexDefinitions.length) {
            throw new Error('Vector indexes are not configured');
        }
        const cardsIndexUid = (vectorSearchConfig.cardsIndex || '').trim();
        const chunksIndexUid = getConfiguredChunkIndexUid();

        let cardsDocs = null;
        let chunksDocs = null;
        let settingsPending = false;
        let embedderReady = true;
        for (const definition of indexDefinitions) {
            const { uid, primaryKey, filterables, distinct } = definition;
            const index = await ensureVectorIndex(uid, primaryKey);
            let settings;
            try {
                settings = await index.getSettings();
            } catch (error) {
                throw new Error(`Failed to read settings for index "${uid}": ${error?.message || error}`);
            }
            const pendingSettings = {};

            const embedders = settings?.embedders || {};
            const currentEmbedder = embedders[vectorSearchConfig.embedderName];
            if (currentEmbedder) {
                const currentDimensions = Number(currentEmbedder.dimensions);
                if (Number.isFinite(currentDimensions) && currentDimensions !== dimensions) {
                    throw new Error(`Embedder "${vectorSearchConfig.embedderName}" on index "${uid}" expects dimension ${currentDimensions}, but the current model produced ${dimensions}. Recreate the index or update config.vectorSearch.embedDimensions.`);
                }
            } else {
                embedderReady = false;
                pendingSettings.embedders = {
                    ...embedders,
                    [vectorSearchConfig.embedderName]: {
                        source: 'userProvided',
                        dimensions
                    }
                };
            }

            const currentFilterables = Array.isArray(settings?.filterableAttributes)
                ? settings.filterableAttributes
                : [];
            const requiredFilterables = Array.isArray(filterables) && filterables.length
                ? filterables
                : currentFilterables;
            const missingFilterables = requiredFilterables.filter(attr => !currentFilterables.includes(attr));
            if (missingFilterables.length > 0) {
                pendingSettings.filterableAttributes = Array.from(new Set([...currentFilterables, ...requiredFilterables]));
            }

            if (distinct && settings?.distinctAttribute !== distinct) {
                pendingSettings.distinctAttribute = distinct;
            }

            if (Object.keys(pendingSettings).length > 0) {
                const alreadyPending = await hasPendingSettingsUpdate(uid);
                if (alreadyPending) {
                    settingsPending = true;
                    log.warn(`Settings update already pending for index "${uid}"`);
                    continue;
                }
                const task = await index.updateSettings(pendingSettings);
                let completed = true;
                if (waitTimeoutMs <= 0) {
                    completed = false;
                } else {
                    completed = await waitForIndexTask(index, task, {
                        timeoutMs: waitTimeoutMs,
                        allowFallback: allowFallbackWait,
                        label: `Meili settings (${uid})`
                    });
                }
                if (completed) {
                    log.info(`Updated settings for index "${uid}" (${Object.keys(pendingSettings).join(', ')})`);
                } else {
                    settingsPending = true;
                    log.warn(`Settings update still processing for index "${uid}"`);
                }
            }

            try {
                const stats = await index.getStats();
                const docCount = typeof stats?.numberOfDocuments === 'number' ? stats.numberOfDocuments : null;
                if (uid === cardsIndexUid) {
                    cardsDocs = docCount;
                } else if (uid === chunksIndexUid) {
                    chunksDocs = docCount;
                }
            } catch (error) {
                log.warn(`Failed to read stats for index "${uid}"`, error);
            }
        }
        if (settingsPending && !allowPending && !embedderReady) {
            vectorIndexReady = false;
            throw new Error('Vector index settings are still updating. Retry shortly.');
        }
        if (!cardsDocs || cardsDocs <= 0) {
            vectorIndexReady = false;
            throw new Error('Vector cards index is empty. Run `npm run vector:backfill` to populate embeddings or disable vector search.');
        }
        chunkIndexHasDocs = chunksIndexUid ? (typeof chunksDocs === 'number' ? chunksDocs > 0 : false) : false;
        if (chunksIndexUid && !chunkIndexHasDocs) {
            log.warn('Vector chunk index appears empty; chunk highlights will be disabled until you run `npm run vector:backfill`.');
        }
        vectorIndexReady = embedderReady;
    })().finally(() => {
        vectorIndexSetupPromise = null;
    });
    return vectorIndexSetupPromise;
}

function computeCardFetchLimit(offset, perPage) {
    const multiplier = Math.max(1, vectorSearchConfig.cardsMultiplier);
    const target = Math.max(perPage, Math.ceil((offset + perPage) * multiplier));
    const maxHits = Math.max(50, Math.min(1000, vectorSearchConfig.maxCardHits));
    return Math.min(maxHits, target);
}

function reciprocalRankFusionScores(primaryIds = [], secondaryIds = [], { chunkWeight = 0.6, rrfK = 60 } = {}) {
    const scores = new Map();
    const contribute = (id, rank, weight = 1) => {
        if (!id) return;
        const contribution = weight * (1 / (rrfK + rank));
        scores.set(id, (scores.get(id) || 0) + contribution);
    };
    primaryIds.forEach((id, idx) => contribute(id, idx + 1, 1));
    secondaryIds.forEach((id, idx) => contribute(id, idx + 1, chunkWeight));
    return scores;
}

function buildChunkHighlightMap(chunkHits = []) {
    const highlights = new Map();
    for (const hit of chunkHits) {
        const cardId = hit?.card_id ?? hit?.cardId;
        if (!cardId) continue;
        const key = String(cardId);
        if (highlights.has(key)) continue;
        highlights.set(key, {
            section: hit.section || null,
            text: hit.text || '',
            chunkIndex: typeof hit.chunk_index === 'number' ? hit.chunk_index : hit.chunkIndex ?? null,
            startToken: typeof hit.start_token === 'number' ? hit.start_token : hit.startToken ?? null,
            endToken: typeof hit.end_token === 'number' ? hit.end_token : hit.endToken ?? null,
            score: typeof hit._rankingScore === 'number' ? hit._rankingScore : null
        });
    }
    return highlights;
}

function estimateTotalHits(result) {
    if (typeof result?.estimatedTotalHits === 'number') {
        return result.estimatedTotalHits;
    }
    if (typeof result?.totalHits === 'number') {
        return result.totalHits;
    }
    return Array.isArray(result?.hits) ? result.hits.length : 0;
}

const CHUNK_FILTER_ALLOWED_ATTRS = [
    'tags',
    'section',
    'card_id',
    'data.creator',
    'data.character_version',
    'data.extensions.nsfw',
    'data.language'
];

const VECTOR_CHUNK_FILTERABLES = [
    'card_id',
    'tags',
    'section',
    'data.creator',
    'data.character_version',
    'data.extensions.nsfw',
    'data.language'
];

const VECTOR_CHUNK_DISTINCT_ATTRIBUTE = 'card_id';

const CHUNK_FILTER_SIMPLE_MAPPINGS = [
    { from: /\btopics\b/gi, to: 'tags' },
    { from: /\blanguage\b/gi, to: 'data.language' },
    { from: /\bcreator\b/gi, to: 'data.creator' },
    { from: /\bauthor\b/gi, to: 'data.creator' }
];

const CHUNK_FILTER_UNSUPPORTED = [
    'hasLorebook',
    'hasAlternateGreetings',
    'hasEmbeddedLorebook',
    'hasLinkedLorebook',
    'hasExampleDialogues',
    'hasSystemPrompt',
    'hasGallery',
    'hasEmbeddedImages',
    'hasExpressions',
    'isFuzzed',
    'favorited',
    'favoritedBool',
    'visibility',
    'source',
    'sourceId',
    'sourcePath',
    'tokenCount'
];

function stripUnsupportedClauses(filterExpr = '') {
    const tokens = filterExpr.split(/(\s+(?:AND|OR)\s+)/i);
    const cleaned = [];
    let lastWasConnector = true;
    for (const token of tokens) {
        if (!token) continue;
        if (/^\s*(AND|OR)\s*$/i.test(token)) {
            if (!lastWasConnector) {
                cleaned.push(token);
                lastWasConnector = true;
            }
            continue;
        }
        const trimmed = token.trim();
        if (!trimmed) continue;
        const containsUnsupported = CHUNK_FILTER_UNSUPPORTED.some(attr => new RegExp(`\\b${attr}\\b`, 'i').test(trimmed));
        if (containsUnsupported) {
            lastWasConnector = true;
            continue;
        }
        cleaned.push(token);
        lastWasConnector = false;
    }
    if (cleaned.length && /^\s*(AND|OR)\s*$/i.test(cleaned[cleaned.length - 1])) {
        cleaned.pop();
    }
    return cleaned.join('').trim();
}

/**
 * Transform a filter AST node for chunk index compatibility.
 * Removes unsupported attributes and maps field names.
 */
function transformChunkFilterNode(node) {
    if (!node) return null;

    switch (node.type) {
        case 'literal': {
            let value = node.value;
            // Map topics → tags (chunks only have tags field)
            value = value.replace(/\btopics\b/gi, 'tags');
            // Map other fields
            value = value.replace(/\blanguage\b/gi, 'data.language');
            value = value.replace(/\bcreator\b/gi, 'data.creator');
            value = value.replace(/\bauthor\b/gi, 'data.creator');

            // Check if contains unsupported attributes
            const hasUnsupported = CHUNK_FILTER_UNSUPPORTED.some(attr =>
                new RegExp(`\\b${attr}\\b`, 'i').test(value)
            );
            return hasUnsupported ? null : { type: 'literal', value };
        }

        case 'not': {
            const child = transformChunkFilterNode(node.child);
            return child ? { type: 'not', child } : null;
        }

        case 'and': {
            const left = transformChunkFilterNode(node.left);
            const right = transformChunkFilterNode(node.right);
            if (!left && !right) return null;
            if (!left) return right;
            if (!right) return left;
            return { type: 'and', left, right };
        }

        case 'or': {
            const leftOr = transformChunkFilterNode(node.left);
            const rightOr = transformChunkFilterNode(node.right);
            if (!leftOr && !rightOr) return null;
            if (!leftOr) return rightOr;
            if (!rightOr) return leftOr;
            return { type: 'or', left: leftOr, right: rightOr };
        }

        default:
            return null;
    }
}

/**
 * Rebuild a filter expression string from a transformed AST.
 */
function rebuildFilterExpression(node) {
    if (!node) return '';

    switch (node.type) {
        case 'literal':
            return node.value;
        case 'not': {
            const child = rebuildFilterExpression(node.child);
            return child ? `NOT (${child})` : '';
        }
        case 'and': {
            const leftAnd = rebuildFilterExpression(node.left);
            const rightAnd = rebuildFilterExpression(node.right);
            if (!leftAnd || !rightAnd) return leftAnd || rightAnd;
            return `(${leftAnd}) AND (${rightAnd})`;
        }
        case 'or': {
            const leftOr = rebuildFilterExpression(node.left);
            const rightOr = rebuildFilterExpression(node.right);
            if (!leftOr || !rightOr) return leftOr || rightOr;
            return `(${leftOr}) OR (${rightOr})`;
        }
        default:
            return '';
    }
}

/**
 * Adapt a filter expression for the chunk index.
 * Uses AST-based transformation to properly handle complex boolean expressions.
 */
function adaptFilterForChunks(filterExpr = '') {
    if (!filterExpr || typeof filterExpr !== 'string') {
        return filterExpr;
    }

    try {
        // Parse into tokens and AST
        const tokens = tokenizeBooleanExpression(filterExpr);
        const ast = parseBooleanExpression(tokens);
        if (!ast) {
            // Log parsing failure with input for debugging
            log.error('Failed to parse chunk filter AST', null, { input: filterExpr });
            log.warn('Falling back to simple replacement for chunk filter');
            let adapted = filterExpr;
            CHUNK_FILTER_SIMPLE_MAPPINGS.forEach(({ from, to }) => {
                adapted = adapted.replace(from, to);
            });
            return stripUnsupportedClauses(adapted) || null;
        }

        // Transform AST
        const transformed = transformChunkFilterNode(ast);
        if (!transformed) {
            log.warn('Chunk filter transformation resulted in null (likely all unsupported attributes)');
            return null;
        }

        // Rebuild expression
        const rebuilt = rebuildFilterExpression(transformed);
        if (!rebuilt) {
            log.warn('Failed to rebuild chunk filter expression from AST');
            return null;
        }
        return rebuilt;
    } catch (error) {
        // Log the actual error with full context for debugging
        log.error('Failed to adapt chunk filter', error, { input: filterExpr });

        // Attempt simple fallback only for non-syntax errors
        log.warn('Attempting simple replacement fallback for chunk filter');
        try {
            let adapted = filterExpr;
            CHUNK_FILTER_SIMPLE_MAPPINGS.forEach(({ from, to }) => {
                adapted = adapted.replace(from, to);
            });
            const result = stripUnsupportedClauses(adapted);
            if (result) {
                log.info('Fallback replacement succeeded for chunk filter');
                return result;
            }
            else {
                log.warn('Fallback replacement produced null result');
                return null;
            }
        } catch (fallbackError) {
            log.error('Fallback replacement also failed', fallbackError);
            return null;
        }
    }
}

export async function searchVectorCards({
    text = '',
    filter = '',
    page = 1,
    limit = 48,
    sort = 'new',
    semanticRatio = null
} = {}) {
    ensureVectorClient();

    const normalizedFilter = normalizeFilterExpression(filter);
    const perPage = Math.max(1, Math.min(limit, 200));
    const pageNumber = Math.max(1, page);
    const offset = (pageNumber - 1) * perPage;
    const effectiveSemanticRatio = typeof semanticRatio === 'number' && Number.isFinite(semanticRatio)
        ? Math.min(1, Math.max(0, semanticRatio))
        : vectorSearchConfig.semanticRatio;

    const embedding = await fetchQueryEmbedding(text);
    await ensureVectorIndexesReady(embedding.length, {
        waitTimeoutMs: 0,
        allowPending: true,
        allowFallbackWait: false
    });
    if (!vectorIndexReady) {
        return {
            ids: [],
            total: 0,
            appliedFilter: normalizedFilter,
            chunkMatches: {},
            scores: {},
            meta: {
                semanticRatio: effectiveSemanticRatio,
                cardsFetched: 0,
                chunksFetched: 0,
                skippedReason: 'settings-pending'
            }
        };
    }

    const cardsIndex = getVectorIndex(vectorSearchConfig.cardsIndex);
    const chunksIndex = chunksAreEnabled() ? getVectorIndex(vectorSearchConfig.chunksIndex) : null;
    if (!cardsIndex) {
        throw new Error('Vector cards index is unavailable');
    }

    const cardsLimit = computeCardFetchLimit(offset, perPage);
    const chunkLimitSetting = Number.isFinite(vectorSearchConfig.chunkLimit)
        ? vectorSearchConfig.chunkLimit
        : perPage;
    const chunkLimit = Math.max(perPage, Math.min(chunkLimitSetting, 200));

    const searchPayload = {
        q: text,
        vector: embedding,
        limit: cardsLimit,
        offset: 0,
        showRankingScore: true,
        hybrid: {
            embedder: vectorSearchConfig.embedderName,
            semanticRatio: effectiveSemanticRatio
        }
    };
    if (normalizedFilter) {
        searchPayload.filter = normalizedFilter;
    }
    const chunkFilterExpression = adaptFilterForChunks(normalizedFilter);

    const chunkSearchEnabled = chunksAreEnabled() && chunkIndexHasDocs && Boolean(chunksIndex);
    const runVectorSearch = async () => Promise.all([
        cardsIndex.search(text, searchPayload),
        chunkSearchEnabled
            ? chunksIndex.search(text, {
                q: text,
                vector: embedding,
                limit: chunkLimit,
                offset: 0,
                filter: chunkFilterExpression || undefined,
                attributesToRetrieve: ['id', 'card_id', 'section', 'chunk_index', 'text', 'start_token', 'end_token'],
                showRankingScore: true,
                distinct: 'card_id',
                hybrid: {
                    embedder: vectorSearchConfig.embedderName,
                    semanticRatio: 1
                }
            })
            : Promise.resolve({ hits: [] })
    ]);

    let cardsResult;
    let chunksResult;
    try {
        [cardsResult, chunksResult] = await runVectorSearch();
    } catch (error) {
        if (!isMissingEmbedderError(error)) {
            throw error;
        }
        log.warn('Vector embedder missing; scheduling vector index refresh');
        resetVectorIndexState('missing-embedder');
        try {
            await ensureVectorIndexesReady(embedding.length, {
                waitTimeoutMs: 0,
                allowPending: true,
                allowFallbackWait: false
            });
        } catch (refreshError) {
            log.warn('Vector index refresh failed', refreshError);
        }
        return {
            ids: [],
            total: 0,
            appliedFilter: normalizedFilter,
            chunkMatches: {},
            scores: {},
            meta: {
                semanticRatio: effectiveSemanticRatio,
                cardsFetched: 0,
                chunksFetched: 0,
                skippedReason: 'embedder-missing'
            }
        };
    }

    const cardHits = Array.isArray(cardsResult?.hits) ? cardsResult.hits : [];
    const chunkHits = Array.isArray(chunksResult?.hits) ? chunksResult.hits : [];
    const cardIds = cardHits.map(hit => (hit && typeof hit.id !== 'undefined') ? String(hit.id) : null).filter(Boolean);
    const chunkIds = chunkHits.map(hit => (hit?.card_id ? String(hit.card_id) : null)).filter(Boolean);

    const rrfScores = reciprocalRankFusionScores(cardIds, chunkIds, {
        chunkWeight: vectorSearchConfig.chunkWeight,
        rrfK: vectorSearchConfig.rrfK
    });
    const fusedIds = Array.from(rrfScores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);

    const pagedIds = fusedIds.slice(offset, offset + perPage);
    const pagedSet = new Set(pagedIds);
    const lexicalWindow = cardIds.slice(offset, offset + perPage);
    lexicalWindow.forEach(id => {
        if (pagedSet.has(id)) {
            return;
        }
        if (pagedIds.length >= perPage) {
            const removed = pagedIds.pop();
            if (removed) {
                pagedSet.delete(removed);
            }
        }
        pagedIds.push(id);
        pagedSet.add(id);
    });
    const chunkHighlights = buildChunkHighlightMap(chunkHits);
    const chunkMatches = {};
    const scores = {};
    pagedIds.forEach(id => {
        if (chunkHighlights.has(id)) {
            chunkMatches[id] = chunkHighlights.get(id);
        }
        // Include RRF score for semantic ranking
        const rrfScore = rrfScores.get(id);
        if (rrfScore !== undefined) {
            scores[id] = rrfScore;
        }
    });

    return {
        ids: pagedIds,
        total: estimateTotalHits(cardsResult),
        appliedFilter: normalizedFilter,
        chunkMatches,
        scores,
        meta: {
            semanticRatio: effectiveSemanticRatio,
            cardsFetched: cardIds.length,
            chunksFetched: chunkIds.length
        }
    };
}

export function chunkArray(list, size = 500) {
    const chunks = [];
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
}

export function getSortAttributes() {
    const attrs = new Set();
    Object.values(SORT_MAP).forEach(rules => {
        rules.forEach(rule => {
            const [attribute] = rule.split(':');
            if (attribute) {
                attrs.add(attribute);
            }
        });
    });
    return Array.from(attrs);
}

export const SEARCHABLE_FIELDS = [
    'name',
    'tagline',
    'description',
    'platform_summary',
    'author',
    'tags',
    'topics',
    'source',
    'sourcePath',
    'sourceSpecific',
    'fullPath'
];

export const FILTERABLE_ATTRIBUTES = Array.from(FILTERABLE_FIELDS);

export async function processIndexQueue({ batchSize = 500 } = {}) {
    if (!isSearchIndexEnabled()) {
        return { processed: 0, hasMore: false };
    }
    const database = getDatabase();
    const rows = database.prepare(
        'SELECT id, cardId, action FROM search_index_queue ORDER BY id LIMIT ?'
    ).all(batchSize);

    if (!rows.length) {
        return { processed: 0, hasMore: false };
    }

    const jobs = new Map();
    rows.forEach(row => {
        const cardId = String(row.cardId);
        const action = row.action === 'delete' ? 'delete' : 'upsert';
        jobs.set(cardId, action);
    });

    const upsertIds = [];
    const deleteIds = [];
    jobs.forEach((action, cardId) => {
        if (action === 'delete') {
            deleteIds.push(cardId);
        } else {
            upsertIds.push(cardId);
        }
    });

    if (deleteIds.length > 0) {
        await deleteDocumentsByIds(deleteIds);
    }

    if (upsertIds.length > 0) {
        const placeholders = upsertIds.map(() => '?').join(', ');
        const cardRows = database.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...upsertIds);
        const documents = cardRows.map(buildSearchDocumentFromRow).filter(Boolean);
        if (documents.length > 0) {
            await indexDocuments(documents);
        }
    }

    const rowIds = rows.map(row => row.id);
    const deletePlaceholders = rowIds.map(() => '?').join(', ');
    database.prepare(`DELETE FROM search_index_queue WHERE id IN (${deletePlaceholders})`).run(...rowIds);

    return {
        processed: rows.length,
        hasMore: rows.length === batchSize
    };
}

export async function rebuildSearchIndexFromRows(rows = []) {
    ensureMeiliEnabled();
    const documents = Array.isArray(rows)
        ? rows.map(buildSearchDocumentFromRow).filter(Boolean)
        : [];

    log.info('Applying default settings to index');
    await applyDefaultSettings();

    log.info('Clearing existing documents');
    const deleteTask = await meiliIndex.deleteAllDocuments();
    await waitForIndexTask(meiliIndex, deleteTask);

    const batches = chunkArray(documents, 1000);
    log.info(`Indexing ${documents.length} documents in ${batches.length} batches`);

    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        if (batch.length === 0) continue;
        const task = await meiliIndex.addDocuments(batch, { primaryKey: 'id' });
        await waitForIndexTask(meiliIndex, task);
        log.info(`Indexed batch ${i + 1}/${batches.length} (${batch.length} documents)`);
    }

    return {
        documents: documents.length
    };
}

let searchIndexRefreshInFlight = false;
let searchIndexRefreshQueued = false;
let searchIndexQueueDrainInFlight = false;

export async function runSearchIndexRefresh(reason = 'manual') {
    if (!isSearchIndexEnabled()) {
        return;
    }

    if (searchIndexRefreshInFlight) {
        searchIndexRefreshQueued = true;
        return;
    }

    searchIndexRefreshInFlight = true;
    try {
        const database = getDatabase();
        const rows = database.prepare('SELECT * FROM cards').all();
        const result = await rebuildSearchIndexFromRows(rows);
        const count = result?.documents ?? rows.length;
        log.info(`Meilisearch index refreshed (${count} docs) [reason=${reason}]`);
    } catch (error) {
        log.error(`Failed to refresh Meilisearch index (${reason})`, error);
    } finally {
        searchIndexRefreshInFlight = false;
        if (searchIndexRefreshQueued) {
            searchIndexRefreshQueued = false;
            runSearchIndexRefresh('queued');
        }
    }
}

export function triggerSearchIndexRefresh(reason = 'manual') {
    if (!isSearchIndexEnabled()) {
        return;
    }
    runSearchIndexRefresh(reason);
}

export async function drainSearchIndexQueue(reason = 'manual') {
    if (!isSearchIndexEnabled() || searchIndexQueueDrainInFlight) {
        return;
    }

    searchIndexQueueDrainInFlight = true;
    let queueHasMore = false;
    try {
        let totalProcessed = 0;
        let iterations = 0;
        do {
            const result = await processIndexQueue();
            totalProcessed += result.processed || 0;
            queueHasMore = Boolean(result.hasMore);
            iterations += 1;
        } while (queueHasMore && iterations < 5);

        if (totalProcessed > 0) {
            log.info(`Meilisearch incremental update processed ${totalProcessed} jobs [reason=${reason}]`);
        }
    } catch (error) {
        log.error(`Failed to process Meilisearch queue (${reason})`, error);
    } finally {
        searchIndexQueueDrainInFlight = false;
    }
}
