import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import textChunk from 'png-chunk-text';
import { analyzePng, analyzeExistingPng, isPngSuspect, detectFuzzPattern } from '../utils/png-utils.js';
import { countImages } from '@character-foundry/image-utils';
import { upsertCard, getDatabase } from '../database.js';
import { resolveTokenCountsFromMetadata, mergeTokenCounts } from '../utils/token-counts.js';
import { logger } from '../utils/logger.js';
import {
    createChubClient,
    rateLimitedRequest,
    loadBlacklist,
    isBlacklisted
} from './ApiClient.js';
import { syncRisuAi } from './scrapers/RisuAiScraper.js';
import { syncWyvern } from './scrapers/WyvernScraper.js';
import { syncCharacterTavern } from './scrapers/CtScraper.js';
import { syncLinkedLorebooks } from './LorebookService.js';
import { lockService } from './LockService.js';

const scraperLogger = logger.scoped('SCRAPER');

// Sharp is no longer used - we extract dimensions directly from PNG IHDR chunks

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fsp = fs.promises;

const PROJECT_ROOT = path.join(__dirname, '../..');
const STATIC_DIR = process.env.CHARACTER_ARCHIVE_STATIC_DIR || path.join(PROJECT_ROOT, 'static');
const BACKUP_DIR = process.env.CHARACTER_ARCHIVE_BACKUP_DIR || path.join(PROJECT_ROOT, 'backup');

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function pathExists(filePath) {
    try {
        await fsp.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function readJsonIfExists(filePath) {
    try {
        const raw = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, payload) {
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 4));
}

async function safeUnlink(filePath) {
    try {
        await fsp.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function safeCopy(src, dest) {
    try {
        await fsp.copyFile(src, dest);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function processWithConcurrency(items, limit, handler) {
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    const maxWorkers = Math.max(1, limit);
    let index = 0;

    const workers = Array.from({ length: Math.min(maxWorkers, items.length) }, () => (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const currentIndex = index;
            index += 1;
            if (currentIndex >= items.length) {
                break;
            }
            await handler(items[currentIndex], currentIndex);
        }
    })());

    await Promise.all(workers);
}

async function detectRemoteGallery(cardId, client) {
    try {
        const response = await client.get(`https://gateway.chub.ai/api/gallery/project/${cardId}`, {
            params: {
                limit: 1,
                count: false
            },
            timeout: 15000
        });

        const data = response.data;
        const items = Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.data)
                ? data.data
                : Array.isArray(data?.gallery)
                    ? data.gallery
                    : Array.isArray(data)
                        ? data
                        : [];

        return Array.isArray(items) && items.length > 0;
    } catch (error) {
        const status = error?.response?.status;
        if (status && status !== 404) {
            scraperLogger.warn(`Gallery detection failed for ${cardId}`, error, { status });
        }
        return null;
    }
}

function scoreDefinitionPayload(definition) {
    if (!definition || typeof definition !== 'object') {
        return 0;
    }
    const data = definition.data;
    if (!data || typeof data !== 'object') {
        return 0;
    }
    const textFields = [
        'description',
        'personality',
        'scenario',
        'first_mes',
        'mes_example',
        'system_prompt',
        'post_history_instructions'
    ];
    let score = 0;
    for (const field of textFields) {
        const value = data[field];
        if (typeof value === 'string') {
            score += Math.min(value.trim().length, 4000);
        }
    }
    if (Array.isArray(data.alternate_greetings)) {
        score += data.alternate_greetings.length * 200;
    }
    if (Array.isArray(data.character_book?.entries)) {
        score += data.character_book.entries.length * 300;
    }
    if (definition.spec === 'chara_card_v2' || data.spec === 'chara_card_v2') {
        score += 500;
    }
    return score;
}

function buildDefinitionCandidate(payload, sourceLabel) {
    if (!payload) {
        return null;
    }
    try {
        let parsed;
        let jsonString;
        if (typeof payload === 'string') {
            jsonString = payload;
            parsed = JSON.parse(payload);
        } else if (typeof payload === 'object') {
            parsed = payload;
            jsonString = JSON.stringify(payload);
        } else {
            return null;
        }
        const score = scoreDefinitionPayload(parsed);
        return { source: sourceLabel, parsed, jsonString, score };
    } catch (error) {
        return null;
    }
}

function selectDefinitionPayload({ rawJson, remoteSource, cardDefinition, existingDefinition, embeddedDefinitions = [] }) {
    const candidates = [];
    const pushCandidate = (payload, source) => {
        const candidate = buildDefinitionCandidate(payload, source);
        if (candidate) {
            candidates.push(candidate);
        }
    };

    pushCandidate(rawJson, remoteSource || 'card_repository');
    pushCandidate(cardDefinition, 'api_definition');
    pushCandidate(existingDefinition, 'local_metadata');
    embeddedDefinitions.forEach(entry => {
        if (!entry) return;
        if (typeof entry === 'string' || typeof entry === 'object') {
            pushCandidate(entry, 'embedded_png');
        } else if (entry.payload) {
            pushCandidate(entry.payload, entry.source || 'embedded_png');
        }
    });

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

function extractDefinitionFromPngBuffer(buffer) {
    if (!buffer || buffer.length === 0) {
        return null;
    }
    const embedded = extractJsonFromPng(buffer, 'chara');
    if (!embedded) {
        return null;
    }

    const attemptDecode = (payload) => {
        if (!payload) return null;
        try {
            const decoded = Buffer.from(payload, 'base64').toString('utf8');
            if (decoded.trim().length === 0) {
                return null;
            }
            return decoded;
        } catch (error) {
            return null;
        }
    };

    let decoded = attemptDecode(embedded);
    if (!decoded) {
        // Some cards store plain JSON instead of base64
        decoded = embedded;
    }
    return decoded;
}

/**
 * Check if PNG is valid (has valid PNG signature)
 */
async function pngCheck(cardId) {
    const cardIdStr = String(cardId);
    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
    const filePath = path.join(subfolder, `${cardIdStr}.png`);

    if (!(await pathExists(filePath))) {
        return false;
    }

    try {
        const buffer = await fsp.readFile(filePath);
        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        return buffer.slice(0, 8).equals(pngSignature);
    } catch (error) {
        return false;
    }
}

/**
 * Extract embedded JSON data from PNG tEXt chunk
 * Returns the base64-encoded chara value if found, null otherwise
 */
function extractJsonFromPng(pngBuffer, key = 'chara') {
    try {
        const chunks = extractChunks(pngBuffer);

        for (const chunk of chunks) {
            if (chunk.name === 'tEXt') {
                const text = Buffer.from(chunk.data).toString('latin1');
                const nullIndex = text.indexOf('\x00');
                if (nullIndex > 0) {
                    const chunkKey = text.substring(0, nullIndex);
                    if (chunkKey === key) {
                        return text.substring(nullIndex + 1);
                    }
                }
            }
        }

        return null;
    } catch (error) {
        scraperLogger.error('Failed to extract JSON from PNG', error);
        return null;
    }
}

/**
 * Embed JSON data into PNG as tEXt chunk
 */
function embedJsonInPng(pngBuffer, key, value) {
    try {
        const chunks = extractChunks(pngBuffer);

        // Remove existing chara chunks
        const filteredChunks = chunks.filter(chunk => {
            if (chunk.name === 'tEXt') {
                const text = Buffer.from(chunk.data).toString('latin1');
                return !text.startsWith('chara\x00');
            }
            return true;
        });

        // Create new text chunk
        // Note: textChunk.encode() returns { name: 'tEXt', data: Uint8Array }
        const newChunk = textChunk.encode(key, value);

        // Insert before IEND
        const iendIndex = filteredChunks.findIndex(c => c.name === 'IEND');
        if (iendIndex > 0) {
            filteredChunks.splice(iendIndex, 0, newChunk);
        }

        return Buffer.from(encodeChunks(filteredChunks));
    } catch (error) {
        scraperLogger.error('Failed to embed JSON in PNG', error);
        return pngBuffer;
    }
}

/**
 * Cached PNG check - uses cached metadata if available
 * @param {string} cardId - The card ID to check
 * @param {object} cache - The metadata cache object
 * @param {boolean} forceRecheck - If true, ignores cache and re-validates the file
 */
async function pngCheckCached(cardId, cache, forceRecheck = false) {
    // If forceRecheck is true, always perform the check (used after writing new files)
    if (!forceRecheck && cache.lastCheck !== undefined) {
        return cache.lastCheck;
    }

    // Perform actual check and cache the result
    const isValid = await pngCheck(cardId);
    cache.lastCheck = isValid;
    return isValid;
}

/**
 * Cached PNG analysis - analyzes buffer and caches metadata
 */
async function analyzePngCached(buffer, cache, key = 'downloaded') {
    // Always analyze the buffer (we need the result), but cache it
    const result = await analyzePng(buffer);
    cache[key] = result;
    return result;
}

/**
 * Download and process a card
 */
export async function downloadCard(card, config, options = {}) {
    const { force = false } = options;

    const cardId = String(card.id);
    const subfolder = path.join(STATIC_DIR, cardId.substring(0, 2));
    ensureDir(subfolder);

    const jsonPath = path.join(subfolder, `${cardId}.json`);
    const imagePath = path.join(subfolder, `${cardId}.png`);

    // Metadata cache to avoid repeated analysis calls during this download
    const metadataCache = {
        existing: null,       // Existing PNG metadata (if any)
        downloaded: null,     // Downloaded/modified PNG metadata
        downloadedBuffer: null // Cache the downloaded PNG buffer to avoid re-downloading
    };

    const hasRelatedLorebook = metadata => Array.isArray(metadata?.related_lorebooks) && metadata.related_lorebooks.length > 0;

    const existingMetadata = await readJsonIfExists(jsonPath);

    const client = createChubClient(config.chubApiKey);
    const db = getDatabase();

    let cachedGalleryCount = 0;
    const cardCacheDir = path.join(STATIC_DIR, 'cached-assets', cardId);
    try {
        const cachedRow = db.prepare(
            'SELECT COUNT(*) as count FROM cached_assets WHERE cardId = ? AND assetType = ?'
        ).get(parseInt(cardId, 10), 'gallery');
        cachedGalleryCount = cachedRow?.count || 0;
    } catch (error) {
        scraperLogger.warn(`Failed to read cached gallery count for ${cardId}`, error);
    }
    if (cachedGalleryCount === 0 && await pathExists(cardCacheDir)) {
        try {
            const files = await fsp.readdir(cardCacheDir);
            if (files.length > 0) {
                cachedGalleryCount = files.length;
            }
        } catch (error) {
            scraperLogger.warn(`Failed to inspect cached gallery directory for ${cardId}`, error);
        }
    }

    const existingFlags = {
        lastActivityAt: existingMetadata?.lastActivityAt || null,
        hasAlternateGreetings: !!existingMetadata?.hasAlternateGreetings,
        hasEmbeddedLorebook: !!existingMetadata?.hasEmbeddedLorebook,
        hasLinkedLorebook: !!existingMetadata?.hasLinkedLorebook || hasRelatedLorebook(existingMetadata),
        hasExampleDialogues: !!existingMetadata?.hasExampleDialogues,
        hasSystemPrompt: !!existingMetadata?.hasSystemPrompt,
        hasGallery: !!existingMetadata?.hasGallery || cachedGalleryCount > 0,
        hasEmbeddedImages: !!existingMetadata?.hasEmbeddedImages,
        hasExpressions: !!existingMetadata?.hasExpressions,
        isFuzzed: !!existingMetadata?.isFuzzed
    };

    let hasAlternateGreetings = existingFlags.hasAlternateGreetings || !!card.hasAlternateGreetings || !!card.has_alternate_greetings;
    let hasEmbeddedLorebook = existingFlags.hasEmbeddedLorebook || !!card.hasEmbeddedLorebook || !!card.has_embedded_lorebook;
    let hasLinkedLorebook = existingFlags.hasLinkedLorebook || hasRelatedLorebook(card) || !!card.hasLinkedLorebook || !!card.has_linked_lorebook;
    let hasExampleDialogues = existingFlags.hasExampleDialogues || !!card.hasExampleDialogues || !!card.has_example_dialogues;
    let hasSystemPrompt = existingFlags.hasSystemPrompt || !!card.hasSystemPrompt || !!card.has_system_prompt;
    let hasGallery = existingFlags.hasGallery || !!card.hasGallery || !!card.has_gallery;
    let hasEmbeddedImages = existingFlags.hasEmbeddedImages || !!card.hasEmbeddedImages || !!card.has_embedded_images;
    let hasExpressions = existingFlags.hasExpressions || (Array.isArray(card.related_extensions) && card.related_extensions.length > 0) || !!card.hasExpressions;
    let isFuzzed = existingFlags.isFuzzed;

    // Check if card has FUZZ tag - indicates creator marked it as fuzzed
    const hasFuzzTag = Array.isArray(card.topics) && card.topics.some(
        topic => typeof topic === 'string' && topic.toLowerCase() === 'fuzz'
    );

    /**
     * Check if card has been updated since we last downloaded it
     * Returns { updated: boolean, reason: string }
     */
    const checkCardUpdated = () => {
        if (!existingMetadata) {
            return { updated: true, reason: 'no_existing_metadata' };
        }

        // Check if last activity date changed
        if (!existingFlags.lastActivityAt) {
            return { updated: true, reason: 'no_existing_date' };
        }

        const remoteLast = card.lastActivityAt || card.updatedAt || card.createdAt;
        if (!remoteLast) {
            return { updated: true, reason: 'no_remote_date' };
        }

        const remoteTime = new Date(remoteLast).getTime();
        const localTime = new Date(existingFlags.lastActivityAt).getTime();

        if (remoteTime > localTime) {
            return { updated: true, reason: 'date_newer' };
        }

        // Check if token count changed (indicates card content updated)
        if (card.tokenCount && existingMetadata.tokenCount) {
            if (card.tokenCount !== existingMetadata.tokenCount) {
                return { updated: true, reason: 'token_count_changed' };
            }
        }

        return { updated: false, reason: 'no_changes' };
    };

    const shouldRefreshPng = () => {
        if (!existingMetadata) return true;

        // Check if fullPath changed - this means it's a DIFFERENT card reusing the same ID
        const existingPath = existingMetadata.fullPath || existingMetadata.path || '';
        const newPath = card.fullPath || card.path || '';
        if (existingPath && newPath && existingPath !== newPath) {
            scraperLogger.info(`Card ID ${cardId} fullPath changed from "${existingPath}" to "${newPath}" - downloading new card`);
            return true;
        }

        if (!existingFlags.lastActivityAt) return true;
        const remoteLast = card.lastActivityAt || card.updatedAt || card.createdAt;
        if (!remoteLast) return true;
        return new Date(remoteLast).getTime() > new Date(existingFlags.lastActivityAt).getTime();
    };

    let remoteGalleryCheck = null;

    const ensureRemoteGallery = async () => {
        if (hasGallery) {
            return;
        }
        if (remoteGalleryCheck !== null) {
            return;
        }
        const detected = await detectRemoteGallery(cardId, client);
        remoteGalleryCheck = detected;
        if (detected === true) {
            hasGallery = true;
        }
    };

    const persistMetadata = async (metadataSource) => {
        const metadataToSave = { ...metadataSource };
        metadataToSave.hasAlternateGreetings = !!hasAlternateGreetings;
        metadataToSave.hasEmbeddedLorebook = !!hasEmbeddedLorebook;
        metadataToSave.hasLinkedLorebook = !!hasLinkedLorebook;
        metadataToSave.hasLorebook = !!(hasEmbeddedLorebook || hasLinkedLorebook);
        metadataToSave.hasExampleDialogues = !!hasExampleDialogues;
        metadataToSave.hasSystemPrompt = !!hasSystemPrompt;
        metadataToSave.hasGallery = !!hasGallery;
        metadataToSave.hasEmbeddedImages = !!hasEmbeddedImages;
        metadataToSave.hasExpressions = !!hasExpressions;
        metadataToSave.isFuzzed = isFuzzed ? 1 : 0;
        metadataToSave.visibility = metadataToSave.visibility || 'unknown';

        // Preserve local-only fields from existing metadata
        if (existingMetadata) {
            metadataToSave.is_favorite = existingMetadata.is_favorite;
            if (typeof existingMetadata.favorited !== 'undefined') {
                metadataToSave.favorited = existingMetadata.favorited;
            }
        }
        if (typeof metadataToSave.favorited === 'undefined') {
            metadataToSave.favorited = metadataToSave.is_favorite ? 1 : 0;
        }

        // Resolve token counts from labels for DATABASE only - don't modify JSON
        const resolvedTokenCounts =
            resolveTokenCountsFromMetadata(metadataToSave) ||
            resolveTokenCountsFromMetadata(metadataSource) ||
            resolveTokenCountsFromMetadata(existingMetadata);

        // Write JSON as-is without token count fields
        await writeJsonFile(jsonPath, metadataToSave);

        // Add token counts to metadata copy for database insert only
        const metadataForDb = { ...metadataToSave };
        if (resolvedTokenCounts) {
            Object.assign(metadataForDb, resolvedTokenCounts);
        }
        upsertCard(metadataForDb);
        return metadataToSave;
    };

    const existingValid = existingMetadata && await pngCheckCached(cardId, metadataCache);

    let shouldDownloadPng = shouldRefreshPng();
    if (force) {
        shouldDownloadPng = true;
    }
    const existingImageInfo = (await pathExists(imagePath)) ? await analyzeExistingPng(imagePath) : null;
    const embeddedDefinitionFromExisting = existingImageInfo?.buffer
        ? extractDefinitionFromPngBuffer(existingImageInfo.buffer)
        : null;

    // Check if existing image is fuzzed
    if (existingImageInfo?.info) {
        const fuzzCheck = detectFuzzPattern(existingImageInfo.info);
        if (fuzzCheck.isFuzz && !isFuzzed) {
            scraperLogger.info(`Detected fuzzed image for ${cardId} (${fuzzCheck.reason}), marking as fuzzed`);
            isFuzzed = true;
        }
    }

    // Check if card has been updated
    const updateCheck = checkCardUpdated();

    // Skip image download ONLY if:
    // 1. Card is fuzzed (has FUZZ tag or detected)
    // 2. We have valid existing image
    // 3. Card hasn't been updated (no date change, no token count change)
    // 4. Not forcing refresh
    if ((isFuzzed || hasFuzzTag) && existingValid && !updateCheck.updated && !force) {
        scraperLogger.info(`Card ${cardId} is fuzzed and unchanged, skipping image download`);
        if (hasFuzzTag && !isFuzzed) {
            isFuzzed = true; // Set flag if FUZZ tag present
        }
        await ensureRemoteGallery();
        const savedMetadata = await persistMetadata(card);
        await syncLinkedLorebooks(savedMetadata, client);
        return false;
    }

    // If card was updated, log the reason
    if (updateCheck.updated && existingMetadata) {
        scraperLogger.info(`Card ${cardId} was updated (${updateCheck.reason}), downloading new version`);
    }

    if (existingValid) {
        if (config.syncTagsMode && card.topics) {
            const hasGalleryChanged = (!!card.hasGallery || !!card.has_gallery) !== !!existingMetadata.hasGallery;
            const remoteExpressions = (Array.isArray(card.related_extensions) && card.related_extensions.length > 0) || !!card.hasExpressions;
            const hasExpressionsChanged = remoteExpressions !== !!existingMetadata.hasExpressions;

            const needsUpdate =
                JSON.stringify(card.topics) !== JSON.stringify(existingMetadata.topics) ||
                card.ratings !== existingMetadata.ratings ||
                card.starCount !== existingMetadata.starCount ||
                hasGalleryChanged ||
                hasExpressionsChanged;

            if (needsUpdate) {
                await ensureRemoteGallery();
                const savedMetadata = await persistMetadata(card);
                await syncLinkedLorebooks(savedMetadata, client);
                scraperLogger.info(`Updated metadata for ${card.name} (${cardId})`);
            }
        }

        if (!force) {
            if (!shouldDownloadPng) {
                await ensureRemoteGallery();
                const savedMetadata = await persistMetadata(existingMetadata);
                await syncLinkedLorebooks(savedMetadata, client);
                scraperLogger.info(`${card.name} (${cardId}) already exists, skipping`);
                return false;
            }
        }

        scraperLogger.info(`Forcing redownload for ${cardId}`);
        if (config.backupMode) {
            ensureDir(BACKUP_DIR);
            const backupDate = existingMetadata.lastActivityAt?.split('T')[0] || 'unknown';
            const backupJson = path.join(BACKUP_DIR, `${cardId}_${backupDate}.json`);
            const backupImage = path.join(BACKUP_DIR, `${cardId}_${backupDate}.png`);

            await safeCopy(jsonPath, backupJson);
            await safeCopy(imagePath, backupImage);
        }
    }

    let attemptedEmbed = false;
    let attemptedFallback = false;

    const downloadRawImage = async () => {
        // Only fetch chara_card_v2.png - WebP/avatar are compressed previews without metadata
        const baseUrl = card.max_res_url || card.avatar_url;
        if (!baseUrl) throw new Error('No image URL available');

        // Always construct chara_card_v2.png URL from base path
        const lastSlash = baseUrl.lastIndexOf('/');
        if (lastSlash === -1) throw new Error('Invalid image URL format');

        const basePath = baseUrl.substring(0, lastSlash + 1);
        const cardV2Url = basePath + 'chara_card_v2.png';

        const candidates = [cardV2Url];

        const tryFetch = async (url) => {
            const imgResponse = await rateLimitedRequest(url, {
                headers: client.defaults.headers,
                responseType: 'arraybuffer'
            });
            const buffer = Buffer.from(imgResponse.data);

            // Analyze and cache metadata for downloaded buffer
            const analysis = await analyzePngCached(buffer, metadataCache, 'downloaded');

            // Cache the buffer so we don't re-download later
            metadataCache.downloadedBuffer = buffer;

            // Skip 240x240 placeholders (common for unavailable/processing images)
            // UNLESS there's no existing image to fall back to
            if (analysis?.width === 240 && analysis?.height === 240) {
                if (existingValid) {
                    scraperLogger.info(`Skipping ${cardId}: Image candidate ${url} is 240x240 placeholder`);
                    return null;
                } else {
                    scraperLogger.warn(`${cardId}: Image candidate ${url} is 240x240 placeholder but using it anyway (no fallback image)`);
                    // Continue and return the placeholder buffer
                }
            }

            return buffer;
        };

        let lastError = null;
        for (const candidate of candidates) {
            try {
                const buffer = await tryFetch(candidate);
                if (buffer) {
                    return buffer;
                }
            } catch (error) {
                const status = error?.response?.status;
                if (status === 404 || status === 403) {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }

        if (lastError) {
            throw lastError;
        }
        return null;
    };

    const fetchCardDefinition = async () => {
        const candidates = [
            { filename: 'card_v2.json', label: 'card_v2' },
            { filename: 'card.json', label: 'card' }
        ];

        for (const candidate of candidates) {
            const jsonUrl = `https://gateway.chub.ai/api/v4/projects/${cardId}/repository/files/${candidate.filename}/raw?ref=main&response_type=blob`;
            try {
                const response = await rateLimitedRequest(jsonUrl, {
                    headers: client.defaults.headers,
                    responseType: 'text'
                });

                if (response?.data) {
                    return {
                        rawJson: response.data,
                        source: candidate.label
                    };
                }
            } catch (error) {
                const status = error?.response?.status;
                if (status && status !== 404) {
                    scraperLogger.warn(`Failed to fetch ${candidate.filename} for ${cardId}`, error, { status });
                }
            }
        }

        return { rawJson: null, source: null };
    };

    try {
        const { rawJson, source: definitionSource } = await fetchCardDefinition();

        await ensureRemoteGallery();

        let imgBuffer = attemptedEmbed || !shouldDownloadPng ? null : await downloadRawImage();
        if (!imgBuffer) {
            await ensureRemoteGallery();
            if (existingValid) {
                const savedMetadata = await persistMetadata(card);
                await syncLinkedLorebooks(savedMetadata, client);
            } else {
                scraperLogger.warn(`Skipping ${cardId}: no PNG available and no previous image to fall back to`);
                await safeUnlink(jsonPath);
            }
            return false;
        }
        const embedDefinitions = [];
        if (embeddedDefinitionFromExisting) {
            embedDefinitions.push({ payload: embeddedDefinitionFromExisting, source: 'embedded_png_existing' });
        }
        const embeddedDefinitionFromDownload = extractDefinitionFromPngBuffer(imgBuffer);
        if (embeddedDefinitionFromDownload) {
            embedDefinitions.push({ payload: embeddedDefinitionFromDownload, source: 'embedded_png_download' });
        }

        const remoteLabel = definitionSource || 'card_repository';
        const selectedDefinition = selectDefinitionPayload({
            rawJson,
            remoteSource: remoteLabel,
            cardDefinition: card?.definition,
            existingDefinition: existingMetadata?.definition,
            embeddedDefinitions: embedDefinitions
        });

        if (!selectedDefinition || !selectedDefinition.jsonString) {
            throw new Error('Unable to resolve a valid card definition payload');
        }

        if (selectedDefinition.source && selectedDefinition.source !== remoteLabel) {
            scraperLogger.info(`Using ${selectedDefinition.source} definition payload for ${cardId} (fallback)`);
        }

        if (selectedDefinition.parsed) {
            card.definition = selectedDefinition.parsed;
        }
        card.definition_source = selectedDefinition.source || remoteLabel;

        const cardData = card.definition?.data;
        if (cardData) {
            const alternateGreetings = cardData.alternate_greetings;
            if (Array.isArray(alternateGreetings) && alternateGreetings.some(g => typeof g === 'string' && g.trim().length > 0)) {
                hasAlternateGreetings = true;
            }

            const lorebookEntries = cardData.character_book?.entries;
            if (Array.isArray(lorebookEntries) && lorebookEntries.length > 0) {
                hasEmbeddedLorebook = true;
            }

            const mesExample = cardData.mes_example;
            if (typeof mesExample === 'string' && mesExample.trim().length > 0) {
                hasExampleDialogues = true;
            }

            const systemPrompt = cardData.system_prompt;
            if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
                hasSystemPrompt = true;
            }

            const extensions = cardData.extensions;
            if (extensions?.gallery && Array.isArray(extensions.gallery) && extensions.gallery.length > 0) {
                hasGallery = true;
            }

            if (cardData.first_mes && countImages(cardData.first_mes) > 0) {
                hasEmbeddedImages = true;
            } else if (Array.isArray(cardData.alternate_greetings)) {
                if (cardData.alternate_greetings.some(g => typeof g === 'string' && countImages(g) > 0)) {
                    hasEmbeddedImages = true;
                }
            }
        }

        const shouldEmbedCustomData = !selectedDefinition.source || !selectedDefinition.source.startsWith('embedded_png');
        let embedSourceLabel = selectedDefinition.source || remoteLabel;
        let modifiedBuffer = imgBuffer;
        if (shouldEmbedCustomData) {
            const base64Json = Buffer.from(selectedDefinition.jsonString).toString('base64');
            modifiedBuffer = embedJsonInPng(imgBuffer, 'chara', base64Json);
            attemptedEmbed = true;
        } else {
            attemptedEmbed = false;
        }

        const newImageInfo = await analyzePngCached(modifiedBuffer, metadataCache, shouldEmbedCustomData ? 'embedded' : 'downloaded');

        // Check if downloaded image is fuzzed
        const downloadedFuzzCheck = detectFuzzPattern(newImageInfo);
        if (downloadedFuzzCheck.isFuzz) {
            scraperLogger.info(`Downloaded image for ${cardId} is fuzzed (${downloadedFuzzCheck.reason})`);
            isFuzzed = true;

            // If we have a good existing image, extract new data and update existing image
            if (existingValid && existingImageInfo?.info && !detectFuzzPattern(existingImageInfo.info).isFuzz) {
                scraperLogger.info(`Extracting updated data from fuzzed PNG for ${cardId}`);

                // Extract embedded data from the fuzzed download
                                    const newEmbeddedData = extractJsonFromPng(modifiedBuffer, 'chara');
                                    if (newEmbeddedData) {
                                        // Re-embed the new data into our existing good image
                                        const updatedImage = embedJsonInPng(existingImageInfo.buffer, 'chara', newEmbeddedData);
                                        await fsp.writeFile(imagePath, updatedImage);
                                        scraperLogger.info(`Updated existing image with new card data for ${cardId}`);
                                    } else {
                                        scraperLogger.warn(`Could not extract data from fuzzed PNG for ${cardId}`);
                                    }
                await ensureRemoteGallery();
                const savedMetadata = await persistMetadata(card);
                await syncLinkedLorebooks(savedMetadata, client);
                return true; // Successfully updated
            }
        }

        const suspectEmbed = isPngSuspect(
            newImageInfo,
            existingImageInfo?.info,
            { skipFuzzWithoutPrevious: !existingValid }
        );

        // For NEW cards (no existing metadata), ALWAYS accept the downloaded PNG even if suspect
        // The suspect check is for detecting corruption, but new cards have no "good" version to fall back to
        if (suspectEmbed && !force && existingMetadata) {
            if (existingValid) {
                scraperLogger.warn(`Suspect PNG for ${cardId}, keeping existing image`);
                await ensureRemoteGallery();
                const savedMetadata = await persistMetadata(card);
                await syncLinkedLorebooks(savedMetadata, client);
                return false;
            } else {
                throw new Error('Suspect PNG with no previous image');
            }
        } else {
            await fsp.writeFile(imagePath, modifiedBuffer);
            attemptedEmbed = true;
            if (suspectEmbed && !existingMetadata) {
                scraperLogger.warn(`Suspect PNG detected for NEW card ${cardId} but accepting anyway (no fallback)`);
            } else if (suspectEmbed) {
                scraperLogger.warn(`Suspect PNG detected for ${cardId} but force override accepted`);
            }
            scraperLogger.info(`Downloaded ${card.name} (${cardId}) with embedded metadata${embedSourceLabel ? ` (${embedSourceLabel})` : ''}`);
        }
    } catch (error) {
        scraperLogger.warn(`Failed to embed metadata for ${cardId}`, error);
        scraperLogger.info(`Falling back to plain image for ${cardId}`);

        try {
            const imgBuffer = await downloadRawImage();
            if (!imgBuffer) {
                await ensureRemoteGallery();
                if (existingValid) {
                    const savedMetadata = await persistMetadata(card);
                    await syncLinkedLorebooks(savedMetadata, client);
                } else {
                    scraperLogger.warn(`Skipping ${cardId}: no PNG available and no previous image to fall back to`);
                    await safeUnlink(jsonPath);
                }
                return false;
            }
            const fallbackInfo = await analyzePngCached(imgBuffer, metadataCache, 'fallback');

            // Check if fallback image is fuzzed
            const fallbackFuzzCheck = detectFuzzPattern(fallbackInfo);
            if (fallbackFuzzCheck.isFuzz) {
                scraperLogger.info(`Fallback image for ${cardId} is fuzzed (${fallbackFuzzCheck.reason})`);
                isFuzzed = true;

                // If we have a good existing image, try to extract and update
                if (existingValid && existingImageInfo?.info && !detectFuzzPattern(existingImageInfo.info).isFuzz) {
                    scraperLogger.info(`Extracting updated data from fuzzed fallback PNG for ${cardId}`);

                    // Try to extract embedded data (fallback images may not have it)
                    const newEmbeddedData = extractJsonFromPng(imgBuffer, 'chara');
                    if (newEmbeddedData) {
                        // Re-embed the new data into our existing good image
                        const updatedImage = embedJsonInPng(existingImageInfo.buffer, 'chara', newEmbeddedData);
                        await fsp.writeFile(imagePath, updatedImage);
                        scraperLogger.info(`Updated existing image with fallback data for ${cardId}`);
                    } else {
                        scraperLogger.info(`Fallback PNG has no embedded data, keeping existing image for ${cardId}`);
                    }

                    await ensureRemoteGallery();
                    const savedMetadata = await persistMetadata(card);
                    await syncLinkedLorebooks(savedMetadata, client);
                    return true; // Successfully handled
                }
            }

            const suspectFallback = isPngSuspect(
                fallbackInfo,
                existingImageInfo?.info,
                { skipFuzzWithoutPrevious: !existingValid }
            );
            if (suspectFallback && !force) {
                if (existingValid) {
                    scraperLogger.warn(`Suspect fallback PNG for ${cardId}, keeping existing image`);
                    await ensureRemoteGallery();
                    const savedMetadata = await persistMetadata(card);
                    await syncLinkedLorebooks(savedMetadata, client);
                    return false;
                } else {
                    scraperLogger.warn(`Suspect fallback PNG for ${cardId} with no previous image`);
                    return false;
                }
            } else {
                await fsp.writeFile(imagePath, imgBuffer);
                attemptedFallback = true;
                if (suspectFallback) {
                    scraperLogger.warn(`Suspect fallback PNG detected for ${cardId} but force override accepted`);
                }
                scraperLogger.info(`Downloaded ${card.name} (${cardId}) - fallback mode`);
            }
        } catch (fallbackError) {
            scraperLogger.error(`Complete failure for ${cardId}`, fallbackError);
            return false;
        }
    }

    card = await persistMetadata(card);
    await syncLinkedLorebooks(card, client);

    // Force recheck since we just wrote a new file
    let validPng = await pngCheckCached(cardId, metadataCache, true);
    if (!validPng && attemptedEmbed && !attemptedFallback) {
        scraperLogger.warn(`Embedded PNG validation failed for ${cardId}, retrying without metadata embed.`);
        try {
            // Try to reuse cached buffer first to avoid re-downloading
            let imgBuffer = metadataCache.downloadedBuffer;
            if (!imgBuffer) {
                scraperLogger.info(`No cached buffer for ${cardId}, re-downloading...`);
                imgBuffer = await downloadRawImage();
            } else {
                scraperLogger.info(`Reusing cached buffer for ${cardId} (avoiding re-download)`);
            }

            if (imgBuffer) {
                const retryInfo = await analyzePngCached(imgBuffer, metadataCache, 'retry');
                const suspectRetry = isPngSuspect(
                    retryInfo,
                    existingImageInfo?.info,
                    { skipFuzzWithoutPrevious: !existingValid }
                );
                if (!suspectRetry || force) {
                    await fsp.writeFile(imagePath, imgBuffer);
                    attemptedFallback = true;
                    // Force recheck since we just wrote a new file
                    validPng = await pngCheckCached(cardId, metadataCache, true);
                    if (suspectRetry) {
                        scraperLogger.warn(`Suspect retry PNG for ${cardId} accepted due to force override`);
                    }
                } else if (existingValid) {
                    scraperLogger.warn(`Suspect retry PNG for ${cardId}, keeping previous image`);
                } else {
                    scraperLogger.warn(`Suspect retry PNG for ${cardId} with no previous image`);
                }
            }
        } catch (retryError) {
            scraperLogger.error(`Fallback retry failed for ${cardId}`, retryError);
        }
    }

    if (!validPng) {
        scraperLogger.warn(`Corrupted PNG for ${cardId}, reverting to previous image`);
        if (existingImageInfo?.buffer) {
            try {
                await fsp.writeFile(imagePath, existingImageInfo.buffer);
                // Force recheck since we just restored from backup
                const restored = await pngCheckCached(cardId, metadataCache, true);
                if (restored) {
                    scraperLogger.warn(`Restored previous PNG for ${cardId}`);
                    return false;
                }
            } catch (restoreError) {
                scraperLogger.error(`Failed to restore previous PNG for ${cardId}`, restoreError);
            }
        }
        await safeUnlink(imagePath);
        return false;
    }

    if (!shouldDownloadPng) {
        scraperLogger.info(`PNG up to date for ${cardId}, skipping download`);
    }
    return true;
}

export async function refreshCard(cardId, config) {
    // Ensure blacklist is loaded so refresh respects skip list
    loadBlacklist();
    const client = createChubClient(config.chubApiKey);
    const response = await client.get(`https://gateway.chub.ai/api/characters/${cardId}`);
    const payload = response.data;
    const card = payload?.node || payload?.data || payload;

    if (!card || !card.id) {
        throw new Error('Card not found on chub');
    }

    await downloadCard(card, config, { force: true });
    return card;
}

/**
 * Sync cards from Chub API
 */
export async function syncCards(config, progressCallback = null) {
    loadBlacklist();
    
    const client = createChubClient(config.chubApiKey);
    const syncLimit = config.syncLimit || 500;
    const pageLimit = config.pageLimit || 1;
    const startPage = config.startPage || 1;
    const maxPage = startPage + pageLimit - 1;
    const syncConcurrency = Math.max(1, Math.min(config.syncConcurrency || 3, 8));

    const tagsList = (config.topic || '').split(',').map(tag => tag.trim()).filter(Boolean);
    const shouldCycleTopics = config.cycle_topics && tagsList.length > 0;
    const followedCreators = Array.isArray(config.followedCreators) ? config.followedCreators.filter(Boolean) : [];

    // Build set of blocked creators for fast lookup (case-insensitive)
    const blockedCreatorsSet = new Set(
        (Array.isArray(config.blockedCreators) ? config.blockedCreators : [])
            .map(c => (c || '').trim().toLowerCase())
            .filter(Boolean)
    );

    // Helper to check if a card is from a blocked creator
    const isCreatorBlocked = (card) => {
        if (blockedCreatorsSet.size === 0) return false;
        const fullPath = card.fullPath || card.path || '';
        if (!fullPath) return false;
        const author = fullPath.split('/')[0]?.toLowerCase();
        return author && blockedCreatorsSet.has(author);
    };

    const timelineSegments = config.use_timeline && !config.followedCreatorsOnly ? pageLimit : 0;
    const searchSegments = !config.followedCreatorsOnly ? (shouldCycleTopics ? tagsList.length : 1) * pageLimit : 0;
    const followedSegments = (config.followedCreatorsOnly || config.syncFollowedCreators) ? followedCreators.length * pageLimit : 0;
    const baseSegments = timelineSegments + searchSegments + followedSegments;
    const estimatedSegments = baseSegments > 0 ? baseSegments : pageLimit;
    const estimatedTotalCards = Math.max(1, syncLimit * estimatedSegments);

    let newCards = 0;
    let errors = 0;
    let processedCount = 0;
    let currentPage = startPage;

    const updateProgress = (cardName = '') => {
        if (!progressCallback) return;
        const progress = Math.min(99, Math.round((processedCount / estimatedTotalCards) * 100));
        progressCallback({
            progress,
            currentCard: cardName,
            newCards
        });
    };
    
    scraperLogger.info(`Starting sync - pages ${startPage} to ${maxPage}, ${syncLimit} cards per page`);

    // Run all enabled scrapers sequentially
    if (!config.skipSecondarySources && config.ctSync?.enabled) {
        scraperLogger.info('Running Character Tavern sync...');
        await syncCharacterTavern(config, progressCallback);
    }

    if (!config.skipSecondarySources && config.risuAiSync?.enabled) {
        scraperLogger.info('Running RisuAI sync...');
        await syncRisuAi(config, progressCallback);
    }

    if (!config.skipSecondarySources && config.wyvernSync?.enabled) {
        scraperLogger.info('Running Wyvern sync...');
        await syncWyvern(config, progressCallback);
    }

    // Timeline mode
    if (config.use_timeline && !config.followedCreatorsOnly) {
        if (!config.chubApiKey) {
            throw new Error('Timeline mode requires an API key');
        }
        
        scraperLogger.info('Using timeline mode');
        
        while (currentPage <= maxPage) {
            // Check for abort
            if (lockService.isSyncAborted()) {
                scraperLogger.info('Chub sync aborted by user (timeline)');
                progressCallback?.({ progress: 100, currentCard: 'Sync cancelled', newCards, cancelled: true });
                return { newCards, cancelled: true };
            }

            try {
                const url = `https://gateway.chub.ai/api/timeline/v1?page=${currentPage}&count=true`;
                const response = await rateLimitedRequest(url, { headers: client.defaults.headers });
                
                const cards = response.data?.data?.nodes || [];
                if (cards.length === 0) {
                    scraperLogger.info(`No cards on page ${currentPage}, ending sync`);
                    break;
                }
                
                await processWithConcurrency(cards, syncConcurrency, async (card) => {
                    processedCount += 1;
                    const cardName = card.name || '';

                    if (card.projectSpace !== 'characters') {
                        updateProgress(cardName);
                        return;
                    }

                    if (card.labels?.some(l => l.title === 'Forked')) {
                        updateProgress(cardName);
                        return;
                    }

                    if (config.min_tokens && card.nTokens < config.min_tokens) {
                        updateProgress(cardName);
                        return;
                    }

                    if (isBlacklisted(card.id)) {
                        updateProgress(cardName);
                        return;
                    }

                    if (isCreatorBlocked(card)) {
                        scraperLogger.debug(`Skipping card ${card.id} from blocked creator`);
                        updateProgress(cardName);
                        return;
                    }

                    try {
                        const ratingsUrl = `https://gateway.chub.ai/api/project/${card.id}/ratings`;
                        const ratingsResp = await rateLimitedRequest(ratingsUrl, { 
                            headers: client.defaults.headers,
                            timeout: 10000 
                        });

                        card.ratingsEnabled = ratingsResp.data.enabled !== false;
                        if (ratingsResp.data.ratings_map) {
                            card.ratings = JSON.stringify(ratingsResp.data.ratings_map);
                        }
                    } catch (error) {
                        scraperLogger.warn(`Failed to fetch ratings for ${card.id}: ${error.message}`);
                    }

                    if (await downloadCard(card, config)) {
                        newCards++;
                    }

                    updateProgress(cardName);
                });
                
                scraperLogger.info(`Page ${currentPage} complete. Total new cards: ${newCards}`);
                currentPage++;
                
            } catch (error) {
                scraperLogger.error(`Failed on page ${currentPage}`, error);
                errors++;
                break;
            }
        }
    } 
    // Regular search mode - runs when syncTagsMode is on OR syncByNew is set (default fallback)
    else if (!config.followedCreatorsOnly && (config.syncTagsMode || config.syncByNew || !config.use_timeline)) {
        const sortBy = config.syncByNew ? 'created_at' : 'last_activity_at';
        const baseParams = {
            search: '',
            first: syncLimit,
            sort: sortBy,
            venus: config.venus ? 'true' : 'false',
            asc: 'false',
            nsfw: 'true',
            nsfl: 'true',
            min_tokens: config.min_tokens || 50,
            namespace: 'characters',
            include_forks: 'true',
            chub: 'true',
            inclusive_or: 'true'
        };

        if (config.excludeTopic) {
            baseParams.excludetopics = config.excludeTopic;
        }

        const runPagesForTag = async (tagLabel, tagValue) => {
            let page = startPage;
            while (page <= maxPage) {
                // Check for abort
                if (lockService.isSyncAborted()) {
                    scraperLogger.info('Chub sync aborted by user (search)');
                    return;
                }

                try {
                    const params = { ...baseParams, page };
                    if (tagValue) params.topics = tagValue;

                    const response = await client.get('https://gateway.chub.ai/search', { params });
                    const cards = response.data?.data?.nodes || [];

                    if (cards.length === 0) {
                        scraperLogger.info(`No cards on page ${page}${tagLabel ? ` for tag '${tagLabel}'` : ''}, moving on.`);
                        break;
                    }

                    await processWithConcurrency(cards, syncConcurrency, async (card) => {
                        processedCount += 1;
                        const cardName = card.name || '';

                        if (isBlacklisted(card.id) || card.id === 88) {
                            updateProgress(cardName);
                            return;
                        }

                        if (isCreatorBlocked(card)) {
                            scraperLogger.debug(`Skipping card ${card.id} from blocked creator`);
                            updateProgress(cardName);
                            return;
                        }

                        try {
                            const ratingsUrl = `https://gateway.chub.ai/api/project/${card.id}/ratings`;
                            const ratingsResp = await rateLimitedRequest(ratingsUrl, { headers: client.defaults.headers });

                            card.ratingsEnabled = ratingsResp.data.enabled !== false;
                            if (ratingsResp.data.ratings_map) {
                                card.ratings = JSON.stringify(ratingsResp.data.ratings_map);
                            }
                        } catch (error) {
                            scraperLogger.warn(`Failed to fetch ratings for ${card.id}`, error);
                        }

                        if (await downloadCard(card, config)) {
                            newCards++;
                        }

                        updateProgress(cardName);
                    });

                    scraperLogger.info(`Page ${page}${tagLabel ? ` (${tagLabel})` : ''} complete. Total new cards: ${newCards}`);
                    page++;
                } catch (error) {
                    scraperLogger.error(`Failed on page ${page}${tagLabel ? ` (${tagLabel})` : ''}`, error);
                    errors++;
                    break;
                }
            }
        };

        if (shouldCycleTopics) {
            for (const tag of tagsList) {
                scraperLogger.info(`Cycle topics enabled. Processing tag '${tag}'.`);
                await runPagesForTag(tag, tag);
            }
        } else {
            await runPagesForTag('', config.topic || '');
        }
    }

    if ((config.syncFollowedCreators || config.followedCreatorsOnly) && followedCreators.length > 0) {
        const creatorsToProcess = followedCreators;

        for (const username of creatorsToProcess) {
            // Check for abort
            if (lockService.isSyncAborted()) {
                scraperLogger.info('Chub sync aborted by user (followed creators)');
                break;
            }

            scraperLogger.info(`Processing followed creator '${username}'.`);
            let page = startPage;

            while (page <= maxPage) {
                // Check for abort
                if (lockService.isSyncAborted()) {
                    break;
                }

                try {
                    const params = {
                        first: syncLimit,
                        page,
                        sort: 'created_at',
                        asc: 'false',
                        nsfw: 'true',
                        nsfl: 'true',
                        min_tokens: config.min_tokens || 50,
                        username: username,
                        namespace: 'characters',
                        include_forks: 'true',
                        exclude_mine: 'false'
                    };

                    const response = await client.get('https://gateway.chub.ai/search', { params });
                    const cards = response.data?.data?.nodes || [];

                    if (cards.length === 0) {
                        scraperLogger.info(`No cards on page ${page} for creator '${username}', moving on.`);
                        break;
                    }

                    await processWithConcurrency(cards, syncConcurrency, async (card) => {
                        processedCount += 1;
                        const cardName = card.name || '';

                        if (isBlacklisted(card.id)) {
                            updateProgress(cardName);
                            return;
                        }

                        if (isCreatorBlocked(card)) {
                            scraperLogger.debug(`Skipping card ${card.id} from blocked creator`);
                            updateProgress(cardName);
                            return;
                        }

                        try {
                            const ratingsUrl = `https://gateway.chub.ai/api/project/${card.id}/ratings`;
                            const ratingsResp = await rateLimitedRequest(ratingsUrl, { headers: client.defaults.headers });

                            card.ratingsEnabled = ratingsResp.data.enabled !== false;
                            if (ratingsResp.data.ratings_map) {
                                card.ratings = JSON.stringify(ratingsResp.data.ratings_map);
                            }
                        } catch (error) {
                            scraperLogger.warn(`Failed to fetch ratings for ${card.id}`, error);
                        }

                        if (await downloadCard(card, config)) {
                            newCards++;
                        }

                        updateProgress(cardName);
                    });

                    scraperLogger.info(`Page ${page} (creator ${username}) complete. Total new cards: ${newCards}`);
                    page++;
                } catch (error) {
                    scraperLogger.error(`Failed on page ${page} for creator '${username}'`, error);
                    errors++;
                    break;
                }
            }
        }
    }

    updateProgress('');
    if (progressCallback) {
        progressCallback({
            progress: 100,
            currentCard: 'Sync complete',
            newCards
        });
    }

    scraperLogger.info(`Sync complete. Total new/updated cards: ${newCards}`);
    return { success: errors === 0 || newCards > 0, newCards, errors };
}

export default {
    downloadCard,
    refreshCard,
    syncCards,
    pngCheck,
    loadBlacklist,
    isBlacklisted
};
