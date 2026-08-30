/**
 * CardController - Thin orchestration layer for card operations
 *
 * Delegates to services:
 * - CardQueryService: listing, search, decoration
 * - CardMetadataService: PNG info, metadata, feature flags
 * - CardService: favorites, gallery flags
 * - asset-cache: gallery caching
 * - scraper: card refresh
 */

import { appConfig } from '../services/ConfigState.js';
import { sillyTavernService } from '../services/SillyTavernService.js';
import { federationService } from '../services/FederationService.js';
import { logger } from '../utils/logger.js';

const log = logger.scoped('CARD');

import {
    LANGUAGE_MAPPING,
    getDatabase,
    toggleFavorite,
    deleteCard as dbDeleteCard
} from '../database.js';

import {
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
} from '../services/CardQueryService.js';

import {
    getPngInfo,
    getCardMetadata,
    syncFeatureFlagsFromMetadata
} from '../services/CardMetadataService.js';

import { getCardFilePaths } from '../utils/card-utils.js';
import { refreshCard } from '../services/scraper.js';
import { refreshRisuCard } from '../services/scrapers/RisuAiScraper.js';
import {
    setCardGalleryFlag,
    setCardFavoriteFlag,
    refreshGalleryIfNeeded
} from '../services/CardService.js';
import { syncFavoriteToChub } from '../services/SyncService.js';
import {
    clearCardAssets,
    cacheGalleryAssets,
    getGalleryAssets,
    rewriteCardUrls
} from '../services/asset-cache.js';

import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import axios from 'axios';

class CardController {
    // ==================== Metadata Endpoints ====================

    getPngInfo = (req, res) => {
        try {
            const cardId = req.params.cardId;
            const spec = getPngInfo(cardId);

            if (!spec) {
                return res.status(404).json({ error: 'No embedded data found' });
            }

            res.json({ data: spec });
        } catch (error) {
            log.error('Get PNG info error', error);
            res.status(500).json({ error: 'Failed to extract PNG info' });
        }
    };

    getCardMetadata = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const metadata = await getCardMetadata(cardId);

            if (!metadata) {
                return res.status(404).json({ error: 'Metadata not found' });
            }

            res.json(metadata);
        } catch (error) {
            log.error('Get metadata error', error);
            res.status(500).json({ error: 'Failed to load metadata' });
        }
    };

    // ==================== Card Actions ====================

    refreshCard = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const db = getDatabase();
            const card = db.prepare('SELECT source FROM cards WHERE id = ?').get(cardId);

            if (card?.source === 'ct') {
                return res.status(400).json({ error: 'Refreshing Character Tavern cards is not currently supported.' });
            }

            if (card?.source === 'risuai') {
                await refreshRisuCard(cardId, appConfig);
            } else {
                await refreshCard(cardId, appConfig);
            }

            const galleryResult = await refreshGalleryIfNeeded(parseInt(cardId, 10));
            invalidateCache();

            res.json({ success: true, gallery: galleryResult });
        } catch (error) {
            log.error('Refresh card error', error);
            res.status(500).json({ error: error.message });
        }
    };

    toggleFavorite = async (req, res) => {
        try {
            const cardId = parseInt(req.params.cardId);
            const database = getDatabase();
            const cardSourceInfo = database.prepare('SELECT id, source, sourceId FROM cards WHERE id = ?').get(cardId);
            const result = toggleFavorite(cardId);

            if (!result.success) {
                return res.json(result);
            }

            const isFavorited = result.favorited === 1;
            await setCardFavoriteFlag(cardId, isFavorited);
            await syncFavoriteToChub(cardSourceInfo, isFavorited);

            let hasGallery = false;
            let galleryResult = null;

            if (isFavorited) {
                galleryResult = await cacheGalleryAssets(cardId, appConfig.chubApiKey);

                if (galleryResult?.success !== false) {
                    const cachedCount = galleryResult?.cached || 0;
                    const skippedCount = galleryResult?.skipped || 0;
                    hasGallery = (cachedCount + skippedCount) > 0;
                } else {
                    const existingGallery = await getGalleryAssets(cardId);
                    hasGallery = existingGallery.success && existingGallery.assets.length > 0;
                    if (galleryResult) {
                        galleryResult.assets = existingGallery.assets;
                    }
                }

                await setCardGalleryFlag(cardId, hasGallery);
            } else {
                galleryResult = await clearCardAssets(cardId, { assetType: 'gallery' });
                await setCardGalleryFlag(cardId, false);
            }

            invalidateCache();

            res.json({ ...result, hasGallery, gallery: galleryResult });
        } catch (error) {
            log.error('Toggle favorite error', error);
            res.status(500).json({ success: false, message: error.message });
        }
    };

    deleteCard = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const cardIdNum = parseInt(cardId);
            const database = getDatabase();

            const existing = database.prepare('SELECT source, sourceId FROM cards WHERE id = ?').get(cardIdNum);
            const { jsonPath, pngPath } = getCardFilePaths(cardId);

            if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
            if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

            try {
                await clearCardAssets(cardIdNum);
            } catch (assetError) {
                log.warn(`Failed to cleanup assets for card ${cardId}`, assetError);
            }

            const result = dbDeleteCard(cardIdNum);

            const blacklistPath = path.join(process.cwd(), 'blacklist.txt');
            fs.appendFileSync(blacklistPath, `${cardId}\n`);

            if (existing?.source === 'ct' && existing.sourceId) {
                const { addCtBlacklistEntry } = await import('../utils/ct-blacklist.js');
                addCtBlacklistEntry(existing.sourceId);
            }

            invalidateCache();
            res.json(result);
        } catch (error) {
            log.error('Delete card error', error);
            res.status(500).json({ error: error.message });
        }
    };

    bulkDelete = async (req, res) => {
        try {
            const ids = req.body.cardIds || req.body.card_ids;

            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ error: 'No card IDs provided' });
            }

            const deleted = [];
            const errors = [];
            const database = getDatabase();
            const { addCtBlacklistEntry } = await import('../utils/ct-blacklist.js');

            for (const rawId of ids) {
                try {
                    const cardId = String(rawId);
                    const cardIdNum = parseInt(cardId);
                    const existing = database.prepare('SELECT source, sourceId FROM cards WHERE id = ?').get(cardIdNum);
                    const { jsonPath, pngPath } = getCardFilePaths(cardId);

                    if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
                    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

                    try {
                        await clearCardAssets(cardIdNum);
                    } catch (assetError) {
                        log.warn(`Failed to cleanup assets for card ${cardId}`, assetError);
                    }

                    dbDeleteCard(cardIdNum);
                    deleted.push(cardId);

                    const blacklistPath = path.join(process.cwd(), 'blacklist.txt');
                    fs.appendFileSync(blacklistPath, `${cardId}\n`);

                    if (existing?.source === 'ct' && existing.sourceId) {
                        addCtBlacklistEntry(existing.sourceId);
                    }
                } catch (err) {
                    errors.push({ cardId: rawId, error: err.message });
                }
            }

            invalidateCache();
            res.json({ success: true, deleted, errors });
        } catch (error) {
            log.error('Bulk delete error', error);
            res.status(500).json({ error: error.message });
        }
    };

    // ==================== Card Updates ====================

    setLanguage = async (req, res) => {
        try {
            const { cardId } = req.params;
            const { language } = req.body;

            if (!language) {
                return res.status(400).json({ error: 'Language is required' });
            }

            const db = getDatabase();
            db.prepare('UPDATE cards SET language = ? WHERE id = ?').run(language, cardId);

            const languageName = LANGUAGE_MAPPING[language] || language;
            res.json({ languageCode: language, languageName });
        } catch (error) {
            log.error('Set language error', error);
            res.status(500).json({ error: error.message });
        }
    };

    editTags = async (req, res) => {
        try {
            const { cardId } = req.params;
            const metadata = req.body;

            let topics = [];
            if (metadata.tags && typeof metadata.tags === 'string') {
                topics = metadata.tags.split(',').map(t => t.trim()).filter(Boolean);
            } else if (Array.isArray(metadata.topics)) {
                topics = metadata.topics;
            } else {
                return res.status(400).json({ error: 'Tags/topics are required' });
            }

            const { jsonPath } = getCardFilePaths(cardId);
            if (fs.existsSync(jsonPath)) {
                const fileData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                fileData.topics = topics;
                fs.writeFileSync(jsonPath, JSON.stringify(fileData, null, 4));
            }

            const db = getDatabase();
            db.prepare('UPDATE cards SET topics = ? WHERE id = ?').run(topics.join(','), parseInt(cardId));

            res.json({ message: 'Tags updated successfully', topics });
        } catch (error) {
            log.error('Edit tags error', error);
            res.status(500).json({ error: error.message });
        }
    };

    // ==================== Export ====================

    exportCard = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const format = req.query.format || 'png';
            const { jsonPath, pngPath, charxPath } = getCardFilePaths(cardId);

            const hasCharx = fs.existsSync(charxPath);
            const hasPng = fs.existsSync(pngPath);

            if (!hasPng && !hasCharx) {
                return res.status(404).json({ error: 'Card not found' });
            }

            if (format === 'json') {
                if (!fs.existsSync(jsonPath)) {
                    return res.status(404).json({ error: 'Metadata not found' });
                }
                res.download(jsonPath, `${cardId}.json`);
            } else if (format === 'charx' && hasCharx) {
                res.download(charxPath, `${cardId}.charx`);
            } else {
                const useLocal = req.query.useLocal !== 'false';
                const result = await rewriteCardUrls(cardId, useLocal);
                res.json(result);
            }
        } catch (error) {
            log.error('Export card error', error);
            res.status(500).json({ error: error.message });
        }
    };

    // ==================== Push to External ====================

    pushToSillyTavern = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const cardIdStr = String(cardId);
            const overwrite = req.body?.overwrite || false;

            // Try federation first
            const stPlatform = federationService.getPlatformConfig('sillytavern');
            if (stPlatform?.enabled && stPlatform?.base_url) {
                try {
                    const result = await federationService.pushToSillyTavern(cardId, overwrite);
                    return res.json({
                        success: true,
                        method: 'federation',
                        filename: result.filename,
                        message: `Pushed via CForge plugin to ${stPlatform.base_url}`
                    });
                } catch (fedError) {
                    log.warn('Federation push failed, falling back to legacy method:', fedError.message);
                }
            }

            // Legacy method
            const { pngPath } = getCardFilePaths(cardIdStr);

            if (!fs.existsSync(pngPath)) {
                return res.status(404).json({ success: false, error: 'Card PNG file not found' });
            }

            const sillyConfig = appConfig.sillyTavern;
            if (!sillyConfig?.enabled || !sillyConfig?.baseUrl) {
                return res.status(400).json({
                    success: false,
                    error: 'SillyTavern integration not configured. Enable federation or configure legacy sillyTavern settings.'
                });
            }

            const baseUrl = sillyConfig.baseUrl.replace(/\/$/, '');
            const baseHeaders = sillyTavernService.buildSillyTavernHeaders(sillyConfig);
            const csrfHeaders = { ...baseHeaders };
            if (sillyConfig.sessionCookie) {
                csrfHeaders.Cookie = sillyConfig.sessionCookie;
            }

            // Get CSRF
            const csrfResponse = await axios.get(`${baseUrl}/csrf-token`, {
                headers: csrfHeaders,
                timeout: 15000,
                validateStatus: () => true
            });

            if (csrfResponse.status < 200 || csrfResponse.status >= 300 || !csrfResponse.data?.token) {
                const message = csrfResponse.data?.error || `Failed to obtain CSRF token (Status: ${csrfResponse.status})`;
                return res.status(csrfResponse.status || 502).json({ success: false, error: message });
            }

            const csrfToken = csrfResponse.data.token;

            // Build cookie header
            const cookieSet = new Set();
            const registerCookie = (value) => {
                if (!value) return;
                const cookieString = value.split(';')[0];
                if (cookieString) cookieSet.add(cookieString.trim());
            };

            const setCookieHeader = csrfResponse.headers['set-cookie'];
            if (Array.isArray(setCookieHeader)) {
                setCookieHeader.forEach(registerCookie);
            } else if (typeof setCookieHeader === 'string') {
                registerCookie(setCookieHeader);
            }

            if (sillyConfig.sessionCookie) {
                const attributePattern = /^(path|max-age|expires|domain|samesite|secure|httponly)/i;
                sillyConfig.sessionCookie
                    .split(';')
                    .map(part => part.trim())
                    .filter(part => part.includes('=') && !attributePattern.test(part))
                    .forEach(part => registerCookie(part));
            }

            const cookieHeader = Array.from(cookieSet).join('; ');

            if (!cookieHeader) {
                return res.status(502).json({ success: false, error: 'Failed to capture session cookies' });
            }

            // Build and send form
            const form = new FormData();
            form.append('avatar', fs.createReadStream(pngPath), {
                filename: `${cardIdStr}.png`,
                contentType: 'image/png'
            });
            form.append('file_type', 'png');
            form.append('preserved_name', cardIdStr);

            const importResponse = await axios.post(`${baseUrl}/api/characters/import`, form, {
                headers: {
                    ...baseHeaders,
                    ...form.getHeaders(),
                    Cookie: cookieHeader,
                    'X-CSRF-Token': csrfToken,
                    Accept: 'application/json, text/plain, */*'
                },
                timeout: 30000,
                maxBodyLength: Infinity,
                validateStatus: () => true
            });

            if (importResponse.status >= 200 && importResponse.status < 300) {
                // Refresh plugin
                try {
                    await axios.post(`${baseUrl}/api/plugins/my-list-cards/refresh`, {}, {
                        headers: { ...baseHeaders, Cookie: cookieHeader, 'X-CSRF-Token': csrfToken },
                        timeout: 20000,
                        validateStatus: () => true
                    });
                } catch (e) { /* ignore */ }

                // Refresh local cache
                try {
                    await sillyTavernService.fetchLoadedIds({ forceRefresh: true, cookieHeader });
                } catch (e) { /* ignore */ }

                return res.json({
                    success: true,
                    method: 'legacy',
                    status: importResponse.status,
                    imported: importResponse.data,
                    fileName: importResponse.data?.file_name || `${cardIdStr}.png`
                });
            }

            res.status(importResponse.status || 502).json({
                success: false,
                error: importResponse.data?.error || 'Import request rejected',
                response: importResponse.data
            });
        } catch (error) {
            log.error('Push to SillyTavern failed', error);
            res.status(500).json({ success: false, error: error.message });
        }
    };

    pushToArchitect = async (req, res) => {
        try {
            const cardId = req.params.cardId;
            const cardIdStr = String(cardId);

            // Try federation first
            const architectPlatform = federationService.getPlatformConfig('architect');
            if (architectPlatform?.enabled && architectPlatform?.base_url) {
                try {
                    const result = await federationService.pushToArchitect(cardId);
                    return res.json({
                        success: true,
                        method: 'federation',
                        remoteId: result.remoteId,
                        message: `Pushed via federation to ${architectPlatform.base_url}`
                    });
                } catch (fedError) {
                    log.warn('Federation push to Architect failed:', fedError.message);
                }
            }

            // Legacy method
            const architectUrl = appConfig.characterArchitect?.url || 'http://localhost:3456';
            const { pngPath } = getCardFilePaths(cardIdStr);

            if (!fs.existsSync(pngPath)) {
                return res.status(404).json({ success: false, error: 'Card PNG file not found' });
            }

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const publicUrl = `${baseUrl}/static/${cardIdStr.substring(0, 2)}/${cardIdStr}.png`;

            const response = await axios.post(
                `${architectUrl}/api/import-url`,
                { url: publicUrl },
                { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
            );

            res.json({
                success: true,
                method: 'legacy',
                message: response.status === 201 ? 'Card pushed successfully' : 'Card pushed with non-standard response',
                architectResponse: response.data
            });
        } catch (error) {
            log.error('Push to Architect failed', error);
            let errorMessage = error.message;
            if (error.code === 'ECONNREFUSED') {
                errorMessage = 'Character Architect is not running or not accessible';
            }
            res.status(500).json({ success: false, error: errorMessage });
        }
    };

    // ==================== List Cards ====================

    async listCards(req, res) {
        try {
            const params = parseListParams(req.query);
            const cacheKey = buildCacheKey(params);

            // Check cache
            const cached = checkCache(cacheKey);
            if (cached) {
                res.set('X-Cache', 'HIT');
                res.set('X-Response-Time', '0ms');
                return res.json(cached);
            }

            const startTime = Date.now();

            // Fetch integration status
            let integrationStatus;
            try {
                integrationStatus = await fetchIntegrationStatus(params, req.header('cookie'));
            } catch (error) {
                return res.status(error.message.includes('not enabled') ? 400 : 502).json({ error: error.message });
            }

            const { sillyLoadedSet, architectSyncedSet, allowedIds } = integrationStatus;
            const baseUrl = `${req.protocol}://${req.get('host')}`;

            let result;
            let advancedInfo = { enabled: false };

            // Try advanced search if requested
            if (params.useAdvancedSearch) {
                const advancedResult = await performAdvancedSearch(params);

                if (advancedResult.fallback) {
                    advancedInfo.fallbackReason = advancedResult.fallbackReason;
                } else {
                    // Decorate and attach metadata
                    decorateCards(advancedResult.cards, baseUrl, sillyLoadedSet, architectSyncedSet);

                    if (advancedResult.mode === 'vector' && advancedResult.vectorResult) {
                        attachVectorMetadata(advancedResult.cards, advancedResult.vectorResult);
                    }

                    const response = await buildResponse(
                        advancedResult.cards,
                        advancedResult.total,
                        params,
                        {
                            enabled: true,
                            mode: advancedResult.mode,
                            query: params.advancedText || params.query,
                            filter: advancedResult.appliedFilter,
                            vector: advancedResult.mode === 'vector' ? {
                                enabled: true,
                                appliedFilter: advancedResult.vectorResult?.appliedFilter || '',
                                meta: advancedResult.vectorResult?.meta || {},
                                chunkMatches: advancedResult.vectorResult?.chunkMatches || {}
                            } : undefined
                        }
                    );

                    setCache(cacheKey, response, params.page);
                    res.set('X-Cache', 'MISS');
                    res.set('X-Response-Time', `${Date.now() - startTime}ms`);
                    return res.json(response);
                }
            }

            // Basic search fallback
            result = performBasicSearch(params, allowedIds);
            decorateCards(result.cards, baseUrl, sillyLoadedSet, architectSyncedSet);

            const response = await buildResponse(result.cards, result.count, params, advancedInfo);

            setCache(cacheKey, response, params.page);
            res.set('X-Cache', 'MISS');
            res.set('X-Response-Time', `${Date.now() - startTime}ms`);
            res.json(response);
        } catch (error) {
            log.error('Cards API error', error);
            res.status(500).json({ error: 'Failed to load cards' });
        }
    }
}

export const cardController = new CardController();
