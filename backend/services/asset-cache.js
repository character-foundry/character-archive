import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDatabase } from '../database.js';
import { readCardPngSpec } from '../utils/card-utils.js';
import { isURLSafe, extractRemoteImageUrls } from '@character-foundry/character-foundry/image-utils';
import { logger } from '../utils/logger.js';

const log = logger.scoped('ASSET-CACHE');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(__dirname, '../../static', 'cached-assets');

// Security: Allowlist of domains for asset downloads (SSRF protection)
const ALLOWED_ASSET_DOMAINS = [
    'chub.ai', '*.chub.ai',  // Supports wildcards now
    'realm.risuai.net', 'sv.risuai.xyz',
    'app.wyvern.chat', 'api.wyvern.chat',
    'character-tavern.com', '*.character-tavern.com',
    'files.catbox.moe', 'i.imgur.com', 'imgur.com'
];

/**
 * Check if a URL is allowed for asset download (SSRF protection)
 * Now using canonical implementation from @character-foundry/character-foundry/image-utils
 */
function isAssetUrlAllowed(urlString) {
    const result = isURLSafe(urlString, {
        allowedDomains: ALLOWED_ASSET_DOMAINS,
        allowDataUrls: false  // Block data URLs for remote fetching
    });
    return result.safe;
}

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const CHUB_BASE_URL = 'https://gateway.chub.ai';
const DEFAULT_GALLERY_LIMIT = 48;
const GALLERY_NODES_FILENAME = 'gallery-nodes.json';
const DEFAULT_GALLERY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toStaticUrl(relativePath) {
    const normalized = relativePath.split(path.sep).join('/');
    return `/static/${normalized}`;
}

function createChubClient(apiKey = '') {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate'
    };

    if (apiKey) {
        headers['samwise'] = apiKey;
        headers['CH-API-KEY'] = apiKey;
    }

    return axios.create({
        baseURL: CHUB_BASE_URL,
        headers,
        timeout: 30000
    });
}

function normalizeGalleryItems(payload) {
    const seen = new Set();
    const items = [];

    function collectEntries(node, pathIndex = 0) {
        if (!node) return;

        if (Array.isArray(node)) {
            node.forEach((entry, idx) => {
                if (!entry || typeof entry !== 'object') {
                    return;
                }

                const urls = entry.urls || entry.url || entry.image || entry.file || {};
                const primaryUrl =
                    entry.original_url ||
                    entry.secure_url ||
                    entry.url ||
                    entry.primary_image_path ||
                    entry.primaryImagePath ||
                    urls.original ||
                    urls.full ||
                    urls.raw ||
                    urls.file ||
                    urls.url ||
                    entry.image_url ||
                    entry.file?.url ||
                    entry.files?.original ||
                    entry.source_url;

                if (primaryUrl && !seen.has(primaryUrl)) {
                    seen.add(primaryUrl);

                    const thumbUrl =
                        entry.thumbnail ||
                        entry.thumb_url ||
                        urls.thumbnail ||
                        urls.thumb ||
                        urls.preview ||
                        entry.preview_url ||
                        entry.preview ||
                        entry.image?.thumbnail ||
                        entry.thumbnail_url ||
                        entry.preview_image_path ||
                        entry.previewImagePath ||
                        entry.primary_image_preview_path ||
                        null;

                    const title = entry.title || entry.name || entry.caption || '';
                    const caption = entry.caption || entry.description || '';
                    const order = typeof entry.order === 'number' ? entry.order : pathIndex * 1000 + idx;
                    const id = entry.id || entry.uuid || entry.guid || `${order}`;
                    const metadata = {
                        id,
                        title,
                        caption,
                        thumbUrl: thumbUrl || primaryUrl,
                        order,
                        source: 'normalized'
                    };

                    items.push({
                        id,
                        url: primaryUrl,
                        thumbUrl: thumbUrl || primaryUrl,
                        title,
                        caption,
                        order,
                        metadata
                    });
                }
            });
        } else if (typeof node === 'object') {
            Object.values(node).forEach(child => collectEntries(child, pathIndex + 1));
        }
    }

    collectEntries(payload, 0);
    return items;
}

function getCardCacheDir(cardId) {
    return path.join(CACHE_DIR, String(cardId));
}

function getNodesCachePath(cardId) {
    return path.join(getCardCacheDir(cardId), GALLERY_NODES_FILENAME);
}

function readJsonFileSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        log.warn(`Failed to read JSON from ${filePath}`, error);
        return null;
    }
}

function writeJsonFileSafe(filePath, payload) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
        log.warn(`Failed to write JSON to ${filePath}`, error);
    }
}

function isGalleryNodesStale(payload, maxAgeMs) {
    if (!payload || !payload.fetchedAt) {
        return true;
    }
    if (typeof maxAgeMs === 'number' && maxAgeMs === 0) {
        return false;
    }
    const fetchedMs = Date.parse(payload.fetchedAt);
    if (Number.isNaN(fetchedMs)) {
        return true;
    }
    const ageMs = Date.now() - fetchedMs;
    if (typeof maxAgeMs !== 'number' || maxAgeMs <= 0) {
        return ageMs > DEFAULT_GALLERY_CACHE_MAX_AGE_MS;
    }
    return ageMs > maxAgeMs;
}

function extractGalleryItems(payload) {
    if (!payload) {
        return [];
    }

    const nodes = Array.isArray(payload.nodes) ? payload.nodes : null;
    if (nodes && nodes.length > 0) {
        return nodes
            .map((node, index) => {
                if (!node || typeof node !== 'object') {
                    return null;
                }

                const primaryUrl =
                    node.primary_image_path ||
                    node.primaryImagePath ||
                    node.primary_image?.url ||
                    node.primary_image?.path ||
                    node.url ||
                    null;

                if (!primaryUrl) {
                    return null;
                }

                const preview =
                    node.preview ||
                    node.preview_image_path ||
                    node.previewImagePath ||
                    node.primary_image_preview_path ||
                    node.thumbnail ||
                    null;

                const title = node.name || '';
                const caption = node.description || '';
                const order =
                    typeof node.position === 'number'
                        ? node.position
                        : typeof node.order === 'number'
                            ? node.order
                            : index;
                const id = node.uuid || node.item_id || `node-${index}`;
                const metadata = {
                    id,
                    title,
                    caption,
                    thumbUrl: preview || primaryUrl,
                    order,
                    uuid: node.uuid || null,
                    itemId: node.item_id || null,
                    nsfw: !!node.nsfw_image,
                    prompt: node.prompt || null,
                    width: node?.prompt?.width || null,
                    height: node?.prompt?.height || null,
                    fetchedAt: payload.fetchedAt || null,
                    primaryImagePath: primaryUrl,
                    previewImagePath: preview,
                    source: 'gallery-node'
                };

                return {
                    id,
                    url: primaryUrl,
                    thumbUrl: preview || primaryUrl,
                    title,
                    caption,
                    order,
                    metadata
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.order - b.order);
    }

    return normalizeGalleryItems(payload);
}

/**
 * Extract URLs from text (images, audio, video)
 * Now using canonical implementation from @character-foundry/character-foundry/image-utils
 */
function extractMediaUrls(text) {
    if (!text || typeof text !== 'string') return [];
    // Extract all remote image URLs (markdown, HTML, CSS, plain URLs)
    return extractRemoteImageUrls(text).map(img => img.url);
}

/**
 * Extract PNG embedded data
 * Delegates to card-utils.js to avoid code duplication
 */
function extractPngData(cardId) {
    try {
        return readCardPngSpec(cardId);
    } catch (error) {
        log.error('Error extracting PNG data', error);
        return null;
    }
}

/**
 * Recursively scan object for media URLs
 */
function scanObjectForUrls(obj, urls = []) {
    if (!obj) return urls;

    if (typeof obj === 'string') {
        urls.push(...extractMediaUrls(obj));
    } else if (Array.isArray(obj)) {
        obj.forEach(item => scanObjectForUrls(item, urls));
    } else if (typeof obj === 'object') {
        Object.values(obj).forEach(value => scanObjectForUrls(value, urls));
    }

    return urls;
}

/**
 * Scan card metadata for all media URLs
 */
export async function scanCardForUrls(cardId) {
    try {
        const metadataPath = path.join(__dirname, 'static', String(cardId).substring(0, 2), `${cardId}.json`);

        if (!fs.existsSync(metadataPath)) {
            return { urls: [], error: 'Metadata not found' };
        }

        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const allUrls = [];

        // Scan JSON metadata (all fields)
        scanObjectForUrls(metadata, allUrls);

        // Extract and scan PNG embedded data (V2 spec with creator_notes, personality, etc.)
        const pngData = extractPngData(cardId);
        if (pngData) {
            scanObjectForUrls(pngData, allUrls);
        }

        // Deduplicate
        const uniqueUrls = [...new Set(allUrls)];

        log.debug(`Card ${cardId}: Found ${uniqueUrls.length} media URLs`);
        return { urls: uniqueUrls, error: null };
    } catch (error) {
        log.error(`Error scanning card ${cardId}`, error);
        return { urls: [], error: error.message };
    }
}

/**
 * Download and cache a single asset
 */
async function downloadAsset(url, cardId, options = {}) {
    const { assetType: explicitType = null, metadata = null } = options;

    // Security: Validate URL against allowlist (SSRF protection)
    if (!isAssetUrlAllowed(url)) {
        log.warn(`Blocked non-allowed asset URL: ${url}`);
        return null;
    }

    try {
        // Generate hash for filename
        const urlHash = crypto.createHash('md5').update(url).digest('hex');
        const ext = path.extname(new URL(url).pathname).split('?')[0] || '.jpg';
        const filename = `${urlHash}${ext}`;
        const cardDir = getCardCacheDir(cardId);

        // Create card directory if it doesn't exist
        if (!fs.existsSync(cardDir)) {
            fs.mkdirSync(cardDir, { recursive: true });
        }

        const localPath = path.join(cardDir, filename);
        const relativePath = path.join('cached-assets', String(cardId), filename);
        const resolvedType = explicitType || (url.match(/\.(mp3|wav|ogg|m4a)$/i) ? 'audio' : 'image');

        // Skip if already downloaded
        if (fs.existsSync(localPath)) {
            log.debug(`Already cached: ${url}`);
            const stats = fs.statSync(localPath);
            return {
                success: true,
                localPath: relativePath,
                fileSize: stats.size,
                cached: true,
                assetType: resolvedType,
                metadata
            };
        }

        // Download with timeout
        log.debug(`Downloading: ${url}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024, // 50MB limit
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Save to disk
        fs.writeFileSync(localPath, response.data);
        const fileSize = fs.statSync(localPath).size;

        log.debug(`Downloaded: ${url} (${(fileSize / 1024).toFixed(2)} KB)`);

        return {
            success: true,
            localPath: relativePath,
            fileSize,
            cached: false,
            assetType: resolvedType,
            metadata
        };
    } catch (error) {
        log.warn(`Failed to download ${url}`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Cache all assets for a card
 */
export async function cacheCardAssets(cardId) {
    try {
        const db = getDatabase();

        // Scan for URLs
        const { urls, error } = await scanCardForUrls(cardId);
        if (error) {
            return { success: false, error };
        }

        if (urls.length === 0) {
            return { success: true, cached: 0, failed: 0, message: 'No media URLs found' };
        }

        log.info(`Caching ${urls.length} assets for card ${cardId}`);

        const results = { cached: 0, failed: 0, skipped: 0 };

        // Download each asset
        for (const url of urls) {
            const result = await downloadAsset(url, cardId);

            if (result.success) {
                if (result.cached) {
                    results.skipped++;
                } else {
                    results.cached++;
                }

                // Store in database
                try {
                    db.prepare(`
                        INSERT OR REPLACE INTO cached_assets (cardId, originalUrl, localPath, assetType, fileSize, metadata)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(cardId, url, result.localPath, result.assetType, result.fileSize || 0, result.metadata ? JSON.stringify(result.metadata) : null);
                } catch (dbError) {
                    log.error('DB error', dbError);
                }
            } else {
                results.failed++;
            }
        }

        log.info(`Card ${cardId}: ${results.cached} cached, ${results.skipped} skipped, ${results.failed} failed`);

        return {
            success: true,
            cached: results.cached,
            skipped: results.skipped,
            failed: results.failed,
            total: urls.length
        };
    } catch (error) {
        log.error(`Error caching assets for card ${cardId}`, error);
        return { success: false, error: error.message };
    }
}

async function fetchGalleryNodes(client, cardId, limit, maxAttempts) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await client.get(`/api/gallery/project/${cardId}`, {
                params: { limit, count: false }
            });

            const data = response?.data && typeof response.data === 'object'
                ? { ...response.data }
                : { count: 0, nodes: [] };

            data.limit = limit;
            data.fetchedAt = new Date().toISOString();
            return data;
        } catch (error) {
            lastError = error;
            const isDnsRetry = error?.code === 'EAI_AGAIN' || /getaddrinfo/i.test(error?.message || '');
            const shouldRetry = attempt < maxAttempts && isDnsRetry;

            if (!shouldRetry) {
                throw error;
            }

            const delayMs = 1000 * attempt;
            log.warn(`Gallery request DNS failure for card ${cardId}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
            await sleep(delayMs);
        }
    }

    throw lastError;
}

/**
 * Cache gallery assets for a card using the Chub gallery endpoint
 */
export async function cacheGalleryAssets(cardId, apiKey = '', options = {}) {
    const client = createChubClient(apiKey);
    const limit = options.limit ?? DEFAULT_GALLERY_LIMIT;
    const maxAttempts = options.retries ?? 3;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_GALLERY_CACHE_MAX_AGE_MS;
    const forceRefresh = options.forceRefresh ?? false;

    try {
        const cardDir = getCardCacheDir(cardId);
        if (!fs.existsSync(cardDir)) {
            fs.mkdirSync(cardDir, { recursive: true });
        }

        const nodesPath = getNodesCachePath(cardId);
        let nodesPayload = null;
        let usedCache = false;

        if (!forceRefresh) {
            const cachedNodes = readJsonFileSafe(nodesPath);
            if (cachedNodes && !isGalleryNodesStale(cachedNodes, maxAgeMs)) {
                nodesPayload = cachedNodes;
                usedCache = true;
            } else if (cachedNodes) {
                log.debug(`Gallery nodes stale for card ${cardId}`);
            }
        }

        if (!nodesPayload) {
            nodesPayload = await fetchGalleryNodes(client, cardId, limit, maxAttempts);
            nodesPayload.cardId = cardId;
            writeJsonFileSafe(nodesPath, nodesPayload);
            usedCache = false;
        } else {
            log.debug(`Using cached gallery nodes for card ${cardId}`);
        }

        let items = extractGalleryItems(nodesPayload);
        if (items.length === 0 && usedCache) {
            log.debug(`Cached gallery nodes empty for card ${cardId}, refreshing from network`);
            nodesPayload = await fetchGalleryNodes(client, cardId, limit, maxAttempts);
            nodesPayload.cardId = cardId;
            writeJsonFileSafe(nodesPath, nodesPayload);
            items = extractGalleryItems(nodesPayload);
            usedCache = false;
        }

        if (items.length === 0) {
            log.debug(`No gallery items for card ${cardId}`);
            return {
                success: true,
                cached: 0,
                skipped: 0,
                failed: 0,
                total: 0,
                message: 'No gallery items found',
                source: usedCache ? 'cache' : 'network',
                nodesCachedAt: nodesPayload?.fetchedAt || null
            };
        }

        log.info(`Caching ${items.length} gallery assets for card ${cardId}`);

        const db = getDatabase();
        const results = { cached: 0, skipped: 0, failed: 0, total: items.length };
        const assets = [];

        for (const item of items) {
            const baseMetadata = {
                id: item.id,
                title: item.title || '',
                caption: item.caption || '',
                thumbUrl: item.thumbUrl || item.url,
                order: item.order,
                fetchedAt: nodesPayload?.fetchedAt || null,
                primaryImagePath: item.url,
                source: 'gallery-node'
            };

            const metadata = {
                ...baseMetadata,
                ...(item.metadata || {})
            };

            metadata.id = metadata.id || item.id || item.url;
            metadata.title = metadata.title || baseMetadata.title;
            metadata.caption = metadata.caption || baseMetadata.caption;
            metadata.thumbUrl = metadata.thumbUrl || baseMetadata.thumbUrl;
            metadata.order = typeof metadata.order === 'number' ? metadata.order : baseMetadata.order;
            metadata.primaryImagePath = metadata.primaryImagePath || item.url;
            metadata.nodesFetchedAt = nodesPayload?.fetchedAt || metadata.fetchedAt || null;

            const result = await downloadAsset(item.url, cardId, { assetType: 'gallery', metadata });

            if (result.success) {
                const staticUrl = toStaticUrl(result.localPath);
                metadata.localUrl = staticUrl;
                metadata.thumbUrlLocal = staticUrl;
                metadata.downloadedAt = new Date().toISOString();
                metadata.originalUrl = item.url;

                if (result.cached) {
                    results.skipped++;
                } else {
                    results.cached++;
                }

                try {
                    db.prepare(`
                        INSERT OR REPLACE INTO cached_assets (cardId, originalUrl, localPath, assetType, fileSize, metadata)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(cardId, item.url, result.localPath, result.assetType, result.fileSize || 0, JSON.stringify(metadata));
                } catch (dbError) {
                    log.error('DB error storing gallery asset', dbError);
                }

                assets.push({
                    id: metadata.id || item.url,
                    url: staticUrl,
                    originalUrl: item.url,
                    title: metadata.title,
                    caption: metadata.caption,
                    thumbUrl: metadata.thumbUrlLocal || staticUrl,
                    order: metadata.order
                });
            } else {
                results.failed++;
            }
        }

        log.info(`Gallery cache complete for ${cardId}: ${results.cached} cached, ${results.skipped} skipped, ${results.failed} failed`);

        return {
            success: true,
            ...results,
            assets,
            source: usedCache ? 'cache' : 'network',
            nodesCachedAt: nodesPayload?.fetchedAt || null
        };
    } catch (error) {
        if (error?.response?.status === 401 || error?.response?.status === 403) {
            log.warn(`Gallery request unauthorized for card ${cardId}`);
            return {
                success: false,
                error: 'Gallery download requires a valid Chub API key',
                cached: 0,
                skipped: 0,
                failed: 0,
                total: 0
            };
        }

        log.error(`Error caching gallery for card ${cardId}`, error);
        return {
            success: false,
            error: error?.message || 'Unknown gallery error',
            cached: 0,
            skipped: 0,
            failed: 0,
            total: 0
        };
    }
}

/**
 * Get cached assets for a card
 */
export async function getCachedAssets(cardId) {
    try {
        const db = getDatabase();
        const assets = db.prepare(`
            SELECT * FROM cached_assets
            WHERE cardId = ?
            ORDER BY cachedAt DESC
        `).all(cardId);

        return { success: true, assets };
    } catch (error) {
        log.error('Error getting cached assets', error);
        return { success: false, error: error.message, assets: [] };
    }
}

/**
 * Get cached gallery assets for a card
 */
export async function getGalleryAssets(cardId) {
    try {
        const db = getDatabase();
        const rows = db.prepare(`
            SELECT originalUrl, localPath, metadata, cachedAt
            FROM cached_assets
            WHERE cardId = ? AND assetType = 'gallery'
        `).all(cardId);

        const assets = rows.map(row => {
            let metadata = null;
            try {
                metadata = row.metadata ? JSON.parse(row.metadata) : null;
            } catch {
                metadata = null;
            }

            const order = metadata && typeof metadata.order === 'number' ? metadata.order : 0;
            const localUrl = toStaticUrl(row.localPath);
            const thumbLocal = metadata?.thumbUrlLocal || metadata?.localUrl || localUrl;
            const originalUrl = metadata?.originalUrl || metadata?.primaryImagePath || row.originalUrl;

            return {
                id: metadata?.id || row.originalUrl,
                url: localUrl,
                originalUrl,
                title: metadata?.title || '',
                caption: metadata?.caption || '',
                thumbUrl: thumbLocal || metadata?.thumbUrl || metadata?.preview || originalUrl,
                order,
                cachedAt: row.cachedAt,
                nodesFetchedAt: metadata?.nodesFetchedAt || metadata?.fetchedAt || null
            };
        }).sort((a, b) => {
            if (a.order === b.order) {
                return (a.cachedAt || '').localeCompare(b.cachedAt || '');
            }
            return a.order - b.order;
        });

        return { success: true, assets };
    } catch (error) {
        log.error('Error getting gallery assets', error);
        return { success: false, error: error.message, assets: [] };
    }
}

/**
 * Clear cached assets for a card
 */
export async function clearCardAssets(cardId, options = {}) {
    try {
        const { assetType = null } = options;
        const db = getDatabase();

        // Get assets to delete
        const params = assetType ? [cardId, assetType] : [cardId];
        const selectSql = assetType
            ? 'SELECT localPath FROM cached_assets WHERE cardId = ? AND assetType = ?'
            : 'SELECT localPath FROM cached_assets WHERE cardId = ?';

        const assets = db.prepare(selectSql).all(...params);

        // Delete files
        for (const asset of assets) {
            const fullPath = path.join(__dirname, 'static', asset.localPath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }

        // Delete directory if empty
        const cardDir = path.join(CACHE_DIR, String(cardId));
        if (fs.existsSync(cardDir) && fs.readdirSync(cardDir).length === 0) {
            fs.rmdirSync(cardDir);
        }

        // Delete from database
        const deleteSql = assetType
            ? 'DELETE FROM cached_assets WHERE cardId = ? AND assetType = ?'
            : 'DELETE FROM cached_assets WHERE cardId = ?';
        db.prepare(deleteSql).run(...params);

        log.info(`Cleared ${assetType || 'all'} assets for card ${cardId}`);
        return { success: true, removed: assets.length };
    } catch (error) {
        log.error('Error clearing assets', error);
        return { success: false, error: error.message };
    }
}

/**
 * Rewrite card metadata to use cached URLs
 */
export async function rewriteCardUrls(cardId, useLocal = true) {
    try {
        const metadataPath = path.join(__dirname, 'static', String(cardId).substring(0, 2), `${cardId}.json`);

        if (!fs.existsSync(metadataPath)) {
            return { success: false, error: 'Metadata not found' };
        }

        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const db = getDatabase();

        // Get URL mappings
        const assets = db.prepare(`SELECT originalUrl, localPath FROM cached_assets WHERE cardId = ?`).all(cardId);
        const urlMap = new Map(assets.map(a => [a.originalUrl, `/static/${a.localPath}`]));

        function replaceUrls(text) {
            if (!text || typeof text !== 'string') return text;
            let result = text;
            for (const [original, local] of urlMap.entries()) {
                result = result.replace(new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), useLocal ? local : original);
            }
            return result;
        }

        // Create modified copy
        const modifiedMetadata = JSON.parse(JSON.stringify(metadata));

        if (modifiedMetadata.description) modifiedMetadata.description = replaceUrls(modifiedMetadata.description);
        if (modifiedMetadata.scenario) modifiedMetadata.scenario = replaceUrls(modifiedMetadata.scenario);
        if (modifiedMetadata.first_mes) modifiedMetadata.first_mes = replaceUrls(modifiedMetadata.first_mes);
        if (modifiedMetadata.mes_example) modifiedMetadata.mes_example = replaceUrls(modifiedMetadata.mes_example);

        if (Array.isArray(modifiedMetadata.alternate_greetings)) {
            modifiedMetadata.alternate_greetings = modifiedMetadata.alternate_greetings.map(g =>
                typeof g === 'string' ? replaceUrls(g) : g
            );
        }

        return { success: true, metadata: modifiedMetadata, replacements: urlMap.size };
    } catch (error) {
        log.error('Error rewriting URLs', error);
        return { success: false, error: error.message };
    }
}
