/**
 * CardQueryService - Handles card listing, search, and decoration
 *
 * Extracted from CardController.listCards to provide:
 * - Query parameter parsing and normalization
 * - Cache key generation
 * - Basic database search
 * - Advanced Meilisearch search
 * - Vector/semantic search
 * - Card decoration (imagePath, sillyTavern status, architect status)
 */

import {
    getCards,
    getCardsByIdsOrdered,
    getAllLanguages,
    getRandomTags,
    LANGUAGE_MAPPING
} from '../database.js';
import {
    isSearchIndexEnabled,
    isVectorSearchReady,
    searchMeilisearchCards,
    searchVectorCards
} from './search-index.js';
import { cacheService } from './CacheService.js';
import { sillyTavernService } from './SillyTavernService.js';
import { getRemoteCardNames } from './FederationService.js';
import { appConfig } from './ConfigState.js';
import { buildMeilisearchFilter } from '../utils/searchUtils.js';
import { logger } from '../utils/logger.js';

const log = logger.scoped('CARD-QUERY');

/**
 * Parse and normalize query parameters from request
 */
export function parseListParams(query) {
    const page = parseInt(query.page) || 1;
    const rawLimit = parseInt(query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 48;

    const sourceParam = query.source ? query.source.toString() : 'all';
    const normalizedSource = ['chub', 'ct', 'risuai', 'wyvern'].includes(sourceParam) ? sourceParam : 'all';

    const minTokensRaw = parseInt(query.minTokens, 10);
    const minTokens = Number.isFinite(minTokensRaw) && minTokensRaw > 0 ? minTokensRaw : null;

    return {
        page,
        limit,
        query: (query.query || '').toString(),
        useAdvancedSearch: query.advanced === 'true',
        advancedText: (query.advancedText || '').toString(),
        advancedFilter: (query.advancedFilter || '').toString(),
        include: (query.include || '').toString(),
        exclude: (query.exclude || '').toString(),
        searchType: (query.type || 'full').toString(),
        tagMatchMode: (query.tagMatchMode || 'or').toString(),
        sort: (query.sort || 'new').toString(),
        language: query.language ? query.language.toString() : null,
        favoriteFilter: query.favorite ? query.favorite.toString() : null,
        source: normalizedSource,
        minTokens,
        // Feature flags
        hasAlternateGreetings: query.hasAlternateGreetings === 'true',
        hasLorebook: query.hasLorebook === 'true',
        hasEmbeddedLorebook: query.hasEmbeddedLorebook === 'true',
        hasLinkedLorebook: query.hasLinkedLorebook === 'true',
        hasExampleDialogues: query.hasExampleDialogues === 'true',
        hasSystemPrompt: query.hasSystemPrompt === 'true',
        hasGallery: query.hasGallery === 'true',
        hasEmbeddedImages: query.hasEmbeddedImages === 'true',
        hasExpressions: query.hasExpressions === 'true',
        // Integration filters
        inSillyTavern: query.inSillyTavern === 'true',
        withSillyStatus: query.withSillyStatus === 'true',
        followedOnly: query.followedOnly === 'true'
    };
}

/**
 * Build cache key for query (null if caching disabled for this query)
 */
export function buildCacheKey(params) {
    // Don't cache first page or queries with live status checks
    if (params.page <= 1 || params.inSillyTavern || params.withSillyStatus) {
        return null;
    }

    return JSON.stringify({
        page: params.page,
        limit: params.limit,
        query: params.query,
        useAdvancedSearch: params.useAdvancedSearch,
        advancedText: params.advancedText,
        advancedFilter: params.advancedFilter,
        include: params.include,
        exclude: params.exclude,
        tagMatchMode: params.tagMatchMode,
        sort: params.sort,
        language: params.language,
        favoriteFilter: params.favoriteFilter,
        source: params.source,
        hasAlternateGreetings: params.hasAlternateGreetings,
        hasLorebook: params.hasLorebook,
        hasEmbeddedLorebook: params.hasEmbeddedLorebook,
        hasLinkedLorebook: params.hasLinkedLorebook,
        hasExampleDialogues: params.hasExampleDialogues,
        hasSystemPrompt: params.hasSystemPrompt,
        hasGallery: params.hasGallery,
        hasEmbeddedImages: params.hasEmbeddedImages,
        hasExpressions: params.hasExpressions,
        followedOnly: params.followedOnly,
        minTokens: params.minTokens
    });
}

/**
 * Decorate cards with image paths and external status
 */
export function decorateCards(cards, baseUrl, sillyLoadedSet, architectSyncedSet) {
    const sillySet = sillyLoadedSet instanceof Set ? sillyLoadedSet : null;
    const architectSet = architectSyncedSet instanceof Set ? architectSyncedSet : null;

    cards.forEach(card => {
        const imagePath = card.imagePath && card.imagePath.startsWith('/')
            ? card.imagePath
            : `/static/${card.id_prefix}/${card.id}.png`;

        card.imagePath = imagePath;
        card.silly_link = `${baseUrl}${imagePath}`;
        card.loadedInSillyTavern = sillySet ? sillySet.has(String(card.id)) : false;
        card.syncedToArchitect = architectSet ? architectSet.has((card.name || '').toLowerCase()) : false;
    });
}

/**
 * Attach vector search metadata to cards
 */
export function attachVectorMetadata(cards, vectorResult) {
    if (!vectorResult) return;

    if (vectorResult.chunkMatches) {
        cards.forEach(card => {
            if (vectorResult.chunkMatches[card.id]) {
                card.vectorMatch = vectorResult.chunkMatches[card.id];
            }
        });
    }

    if (vectorResult.scores) {
        cards.forEach(card => {
            if (vectorResult.scores[card.id] !== undefined) {
                card.semanticScore = vectorResult.scores[card.id];
            }
        });
    }
}

/**
 * Fetch external integration status (SillyTavern, Architect)
 */
export async function fetchIntegrationStatus(params, cookieHeader) {
    let sillyLoadedSet = null;
    let architectSyncedSet = null;
    let allowedIds = null;

    // Fetch architect card names via federation
    try {
        architectSyncedSet = await getRemoteCardNames('architect');
    } catch (error) {
        log.warn('Failed to fetch architect cards', error.message);
    }

    // Fetch SillyTavern loaded cards if needed
    if (params.inSillyTavern || params.withSillyStatus) {
        if (!appConfig?.sillyTavern?.enabled || !appConfig?.sillyTavern?.baseUrl) {
            if (params.inSillyTavern) {
                throw new Error('Silly Tavern integration is not enabled');
            }
        } else {
            try {
                sillyLoadedSet = await sillyTavernService.fetchLoadedIds({ cookieHeader });
            } catch (error) {
                log.error('Failed to fetch Silly Tavern loaded cards', error.message);
                if (params.inSillyTavern) {
                    throw new Error('Failed to fetch Silly Tavern loaded cards');
                }
                sillyLoadedSet = null;
            }
        }
    }

    // If filtering to only SillyTavern cards, extract IDs
    if (params.inSillyTavern) {
        const idList = sillyLoadedSet ? Array.from(sillyLoadedSet) : [];
        allowedIds = idList
            .map(id => Number.parseInt(id, 10))
            .filter(id => Number.isInteger(id));
        if (!sillyLoadedSet) {
            allowedIds = [];
        }
    }

    return { sillyLoadedSet, architectSyncedSet, allowedIds };
}

/**
 * Perform advanced search (Meilisearch + optional vector)
 */
export async function performAdvancedSearch(params) {
    if (!isSearchIndexEnabled()) {
        return {
            fallback: true,
            fallbackReason: 'Advanced search requires Meilisearch. Falling back to basic search.'
        };
    }

    const meiliFilterExpression = buildMeilisearchFilter({
        advancedFilter: params.advancedFilter,
        include: params.include,
        exclude: params.exclude,
        tagMatchMode: params.tagMatchMode,
        minTokens: params.minTokens,
        language: params.language,
        favoriteFilter: params.favoriteFilter,
        source: params.source,
        hasAlternateGreetings: params.hasAlternateGreetings,
        hasLorebook: params.hasLorebook,
        hasEmbeddedLorebook: params.hasEmbeddedLorebook,
        hasLinkedLorebook: params.hasLinkedLorebook,
        hasExampleDialogues: params.hasExampleDialogues,
        hasSystemPrompt: params.hasSystemPrompt,
        hasGallery: params.hasGallery,
        hasEmbeddedImages: params.hasEmbeddedImages,
        hasExpressions: params.hasExpressions
    });

    const queryText = params.advancedText || params.query || '';
    const hasQueryText = Boolean(queryText.trim());
    const hasAnyFilter = Boolean(meiliFilterExpression && meiliFilterExpression.trim().length > 0);

    if (!hasQueryText && !hasAnyFilter) {
        return {
            fallback: true,
            fallbackReason: 'Advanced search needs a query or filters. Showing default results.'
        };
    }

    // Try vector search if available and we have query text
    const vectorPreferred = hasQueryText && appConfig?.vectorSearch?.enabled === true && isVectorSearchReady();

    if (vectorPreferred) {
        try {
            const [vectorResult, lexicalResult] = await Promise.all([
                searchVectorCards({
                    text: queryText,
                    filter: meiliFilterExpression,
                    page: params.page,
                    limit: params.limit,
                    sort: params.sort
                }),
                searchMeilisearchCards({
                    text: queryText,
                    filter: meiliFilterExpression,
                    page: params.page,
                    limit: params.limit,
                    sort: null
                })
            ]);

            // Merge results: vector first, then lexical to fill
            const vectorIds = Array.isArray(vectorResult.ids) ? vectorResult.ids : [];
            const lexicalIds = Array.isArray(lexicalResult.ids) ? lexicalResult.ids : [];
            const finalIds = [];
            const seen = new Set();

            for (const id of vectorIds) {
                if (finalIds.length >= params.limit) break;
                if (!seen.has(id)) {
                    finalIds.push(id);
                    seen.add(id);
                }
            }

            if (finalIds.length < params.limit) {
                for (const id of lexicalIds) {
                    if (finalIds.length >= params.limit) break;
                    if (!seen.has(id)) {
                        finalIds.push(id);
                        seen.add(id);
                    }
                }
            }

            let cards = [];
            if (finalIds.length > 0) {
                cards = getCardsByIdsOrdered(finalIds);
            }

            const total = lexicalResult.total || vectorResult.total || cards.length;

            return {
                success: true,
                mode: 'vector',
                cards,
                total,
                appliedFilter: vectorResult.appliedFilter || lexicalResult.appliedFilter || '',
                vectorResult,
                lexicalResult
            };
        } catch (error) {
            log.error('Vector search failure', error);
            // Fall through to lexical-only search
        }
    }

    // Lexical-only search
    try {
        const meiliResult = await searchMeilisearchCards({
            text: queryText,
            filter: meiliFilterExpression,
            page: params.page,
            limit: params.limit,
            sort: params.sort
        });

        let cards = [];
        if (meiliResult.ids.length > 0) {
            cards = getCardsByIdsOrdered(meiliResult.ids);
        }

        return {
            success: true,
            mode: 'lexical',
            cards,
            total: meiliResult.total || cards.length,
            appliedFilter: meiliResult.appliedFilter || ''
        };
    } catch (error) {
        log.error('Advanced search failure', error);
        return {
            fallback: true,
            fallbackReason: error?.message || 'Advanced search failed. Falling back to basic search.'
        };
    }
}

/**
 * Perform basic database search
 */
export function performBasicSearch(params, allowedIds) {
    return getCards({
        page: params.page,
        limit: params.limit,
        query: params.query,
        includeQuery: params.include,
        excludeQuery: params.exclude,
        searchType: params.searchType,
        tagMatchMode: params.tagMatchMode,
        sort: params.sort,
        language: params.language,
        favoriteFilter: params.favoriteFilter,
        source: params.source,
        hasAlternateGreetings: params.hasAlternateGreetings,
        hasLorebook: params.hasLorebook,
        hasEmbeddedLorebook: params.hasEmbeddedLorebook,
        hasLinkedLorebook: params.hasLinkedLorebook,
        hasExampleDialogues: params.hasExampleDialogues,
        hasSystemPrompt: params.hasSystemPrompt,
        hasGallery: params.hasGallery,
        hasEmbeddedImages: params.hasEmbeddedImages,
        hasExpressions: params.hasExpressions,
        allowedIds,
        followedOnly: params.followedOnly,
        followedCreators: appConfig.followedCreators || [],
        minTokens: params.minTokens
    });
}

/**
 * Build standard response object
 */
export async function buildResponse(cards, total, params, advancedInfo = {}) {
    const totalPages = Math.max(1, Math.ceil(total / params.limit));

    const [randomTags, languages] = await Promise.all([
        getRandomTags(),
        getAllLanguages()
    ]);

    return {
        cards,
        count: total,
        page: params.page,
        totalPages,
        randomTags,
        languages,
        languageMapping: LANGUAGE_MAPPING,
        advanced: {
            enabled: advancedInfo.enabled || false,
            mode: advancedInfo.mode,
            query: advancedInfo.query,
            filter: advancedInfo.filter,
            fallbackReason: advancedInfo.fallbackReason
        },
        vector: advancedInfo.vector
    };
}

/**
 * Check cache for existing result
 */
export function checkCache(cacheKey) {
    if (!cacheKey) return null;
    return cacheService.get(cacheKey);
}

/**
 * Store result in cache
 */
export function setCache(cacheKey, data, page) {
    if (cacheKey && page > 1) {
        cacheService.set(cacheKey, data);
    }
}

/**
 * Invalidate query cache
 */
export function invalidateCache() {
    cacheService.flush();
}

export default {
    parseListParams,
    buildCacheKey,
    decorateCards,
    attachVectorMetadata,
    fetchIntegrationStatus,
    performAdvancedSearch,
    performBasicSearch,
    buildResponse,
    checkCache,
    setCache,
    invalidateCache
};
