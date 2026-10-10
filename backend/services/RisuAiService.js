import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as cheerioLoad } from 'cheerio';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import textChunk from 'png-chunk-text';
import { readCardJsonOnly, readCharX } from '@character-foundry/character-foundry/charx';
import { getDatabase, upsertCard } from '../database.js';
import { logger } from '../utils/logger.js';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';
import { addToBlacklist, isBlacklisted, loadBlacklist, rateLimitedRequest } from './ApiClient.js';
import { inferTags } from '../utils/keyword-tagger.js';

const log = logger.scoped('RISUAI');
const fsp = fs.promises;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, '../../static');

const BASE_URL = 'https://realm.risuai.net';
const RESOURCE_URL = 'https://sv.risuai.xyz/resource';

// RisuAI blacklist file
const RISUAI_BLACKLIST_FILE = path.join(__dirname, '../../risuai-blacklist.txt');
const RISUAI_COOLDOWN_FILE = path.join(__dirname, '../../risuai-cooldown.json');

// Cooldown period - don't retry cards within this window (24 hours)
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

let risuaiBlacklist = new Set();
let risuaiCooldown = {}; // { risuId: timestamp }

function loadRisuaiBlacklist() {
    try {
        if (fs.existsSync(RISUAI_BLACKLIST_FILE)) {
            const content = fs.readFileSync(RISUAI_BLACKLIST_FILE, 'utf8');
            risuaiBlacklist = new Set(
                content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'))
            );
            log.info(`Loaded ${risuaiBlacklist.size} RisuAI blacklisted cards`);
        }
    } catch (error) {
        log.warn('Failed to load RisuAI blacklist', error.message);
    }
}

function addToRisuaiBlacklist(risuId, reason = '') {
    try {
        risuaiBlacklist.add(risuId);
        const entry = reason ? `${risuId} # ${reason}` : risuId;
        fs.appendFileSync(RISUAI_BLACKLIST_FILE, `${entry}\n`);
        log.info(`Added ${risuId} to RisuAI blacklist: ${reason}`);
    } catch (error) {
        log.warn(`Failed to add ${risuId} to blacklist`, error.message);
    }
}

function isRisuaiBlacklisted(risuId) {
    return risuaiBlacklist.has(risuId);
}

function loadRisuaiCooldown() {
    try {
        if (fs.existsSync(RISUAI_COOLDOWN_FILE)) {
            const content = fs.readFileSync(RISUAI_COOLDOWN_FILE, 'utf8');
            risuaiCooldown = JSON.parse(content);
            // Prune expired entries
            const now = Date.now();
            let pruned = 0;
            for (const [id, ts] of Object.entries(risuaiCooldown)) {
                if (now - ts > COOLDOWN_MS) {
                    delete risuaiCooldown[id];
                    pruned++;
                }
            }
            if (pruned > 0) {
                saveRisuaiCooldown();
            }
            log.info(`Loaded ${Object.keys(risuaiCooldown).length} RisuAI cooldown entries (pruned ${pruned} expired)`);
        }
    } catch (error) {
        log.warn('Failed to load RisuAI cooldown', error.message);
        risuaiCooldown = {};
    }
}

function saveRisuaiCooldown() {
    try {
        fs.writeFileSync(RISUAI_COOLDOWN_FILE, JSON.stringify(risuaiCooldown, null, 2));
    } catch (error) {
        log.warn('Failed to save RisuAI cooldown', error.message);
    }
}

function isOnCooldown(risuId) {
    const ts = risuaiCooldown[risuId];
    if (!ts) return false;
    return (Date.now() - ts) < COOLDOWN_MS;
}

function setCooldown(risuId) {
    risuaiCooldown[risuId] = Date.now();
    // Batch save - don't save every single entry
}

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

function parseDownloadCount(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const str = String(val).toLowerCase();
    if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
    if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000000);
    return Math.round(parseFloat(str)) || 0;
}

/**
 * Parse RisuAI epoch timestamp (weird format: seconds since some epoch / 100000?)
 * Their dates are like 29322496 which is way too small for unix epoch
 */
function parseRisuDate(dateVal) {
    if (!dateVal) return new Date().toISOString();

    // RisuAI uses a weird epoch - multiply by 100000 and add offset
    // Based on observed values, this seems to work
    const num = Number(dateVal);
    if (isNaN(num)) return new Date().toISOString();

    // Their timestamp appears to be: (unix_seconds / 100000) roughly
    // Let's try treating it as seconds since a reference point
    // 29322496 * 100 = ~2932249600 seconds = ~93 years which is too much
    // Try: dateVal * 1000 as seconds -> still wrong
    // Actually looking at Python code: just use it as-is with proper parsing
    // The date is epoch milliseconds / 100000 approximately
    try {
        const ms = num * 100000; // Rough approximation
        const d = new Date(ms);
        if (d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
            return d.toISOString();
        }
    } catch (e) {
        // Fall through
    }

    return new Date().toISOString();
}

/**
 * Embed JSON data into PNG as tEXt chunk (same as scraper.js)
 */
function embedJsonInPng(pngBuffer, key, base64Value) {
    try {
        const chunks = extractChunks(pngBuffer);

        // Remove existing chunks with same key
        const filteredChunks = chunks.filter(chunk => {
            if (chunk.name === 'tEXt') {
                const text = Buffer.from(chunk.data).toString('latin1');
                return !text.startsWith(`${key}\x00`);
            }
            return true;
        });

        // Create new text chunk
        const newChunk = textChunk.encode(key, base64Value);

        // Insert before IEND
        const iendIndex = filteredChunks.findIndex(c => c.name === 'IEND');
        if (iendIndex > 0) {
            filteredChunks.splice(iendIndex, 0, newChunk);
        }

        return Buffer.from(encodeChunks(filteredChunks));
    } catch (error) {
        log.error('Failed to embed JSON in PNG', error);
        return pngBuffer;
    }
}

/**
 * Extract JSON and asset count from CharX (zip) file
 * Uses @character-foundry/character-foundry/charx which handles standard zips, SFX, and JPEG+ZIP hybrids
 * @returns {{ card: object, assetCount: number } | null}
 */
function extractFromCharX(charxBuffer) {
    try {
        // readCharX handles all CharX variants including SFX
        // Increase size limit to 500MB for huge cards
        const result = readCharX(new Uint8Array(charxBuffer), {
            maxTotalSize: 500 * 1024 * 1024 // 500MB
        });
        return {
            card: result.card,
            assetCount: result.assets?.length || 0,
            isRisuFormat: result.isRisuFormat
        };
    } catch (error) {
        log.error('Failed to extract from CharX', error);
        return null;
    }
}

/**
 * Extract just JSON from CharX (for API fetching where we don't have full file yet)
 */
function extractJsonFromCharX(charxBuffer) {
    try {
        const cardJson = readCardJsonOnly(new Uint8Array(charxBuffer));
        return cardJson;
    } catch (error) {
        log.error('Failed to extract JSON from CharX', error);
        return null;
    }
}

/**
 * Fetch card definition JSON from RisuAI API (v3)
 */
async function fetchRisuCardJson(risuId) {
    const url = `${BASE_URL}/api/v1/download/json-v3/${risuId}?non_commercial=true`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'json',
            timeout: 30000
        });
        return { json: response.data, raw: JSON.stringify(response.data), error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { json: null, raw: null, error: error.message, status };
    }
}

/**
 * Fetch card definition JSON from RisuAI API (v2 - legacy fallback)
 */
async function fetchRisuCardJsonV2(risuId) {
    const url = `${BASE_URL}/api/v1/download/json-v2/${risuId}?non_commercial=true`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'json',
            timeout: 30000
        });
        return { json: response.data, raw: JSON.stringify(response.data), error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { json: null, raw: null, error: error.message, status };
    }
}

/**
 * Fetch CharX file and extract card.json
 */
async function fetchRisuCharX(risuId) {
    const url = `${BASE_URL}/api/v1/download/charx-v3/${risuId}`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'arraybuffer',
            timeout: 60000
        });

        const json = extractJsonFromCharX(Buffer.from(response.data));
        if (!json) {
            return { json: null, raw: null, error: 'Failed to extract card.json from CharX' };
        }

        return { json, raw: JSON.stringify(json), error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { json: null, raw: null, error: error.message, status };
    }
}

/**
 * Detect image format from buffer
 */
function detectImageFormat(buffer) {
    if (!buffer || buffer.length < 8) return 'unknown';

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'png';
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'jpg';
    }
    // WebP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'webp';
    }
    // GIF: GIF87a or GIF89a
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return 'gif';
    }

    return 'unknown';
}

/**
 * Fetch thumbnail image from RisuAI CDN (for display only)
 * Returns { buffer, format } or null
 */
async function fetchRisuThumbnail(imgHash) {
    const url = `${RESOURCE_URL}/${imgHash}`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'arraybuffer',
            timeout: 30000
        });
        const buffer = Buffer.from(response.data);
        const format = detectImageFormat(buffer);
        return { buffer, format };
    } catch (error) {
        log.warn(`Failed to fetch thumbnail ${imgHash}`, error.message);
        return null;
    }
}

/**
 * Fetch the full PNG from png-v3 endpoint (contains embedded assets)
 */
async function fetchRisuPngV3(risuId) {
    const url = `${BASE_URL}/api/v1/download/png-v3/${risuId}?non_commercial=true`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'arraybuffer',
            timeout: 120000 // 2 min timeout for large PNGs
        });
        return { buffer: Buffer.from(response.data), error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { buffer: null, error: error.message, status };
    }
}

/**
 * Fetch the full CharX from charx-v3 endpoint
 */
async function fetchRisuCharXFile(risuId) {
    const url = `${BASE_URL}/api/v1/download/charx-v3/${risuId}?non_commercial=true`;
    try {
        const response = await rateLimitedRequest(url, {
            responseType: 'arraybuffer',
            timeout: 120000 // 2 min timeout for large files
        });
        return { buffer: Buffer.from(response.data), error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { buffer: null, error: error.message, status };
    }
}

/**
 * Detect if card is CharX by checking HTML or using dynamic endpoint
 */
async function detectCardFormat(risuId, htmlContent = null) {
    // If we have HTML, check for charx-v3 endpoint reference
    if (htmlContent && htmlContent.includes('/api/v1/download/charx-v3/')) {
        return 'charx';
    }

    // HEAD request to dynamic endpoint to check content-type
    try {
        const url = `${BASE_URL}/api/v1/download/dynamic/${risuId}?cors=true`;
        const response = await axios.head(url, { timeout: 10000 });
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/charx')) {
            return 'charx';
        } else if (contentType.includes('image/png')) {
            return 'png';
        }
    } catch (error) {
        // Fall through to default
    }

    return 'unknown';
}

/**
 * Parse card data from RisuAI HTML page
 */
function parseRisuHtml(html) {
    const $ = cheerioLoad(html);
    const scripts = $('script');
    let cardData = null;
    let isCharX = false;

    scripts.each((i, el) => {
        const text = $(el).html();
        if (text && text.includes('data: [')) {
            try {
                // Manual extraction by counting brackets
                const startMarker = 'data: [';
                const startIndex = text.indexOf(startMarker);
                if (startIndex !== -1) {
                    let openCount = 0;
                    let endIndex = -1;
                    const arrayStartIndex = startIndex + startMarker.length - 1;

                    for (let j = arrayStartIndex; j < text.length; j++) {
                        if (text[j] === '[') openCount++;
                        else if (text[j] === ']') openCount--;

                        if (openCount === 0) {
                            endIndex = j + 1;
                            break;
                        }
                    }

                    if (endIndex !== -1) {
                        const jsonString = text.substring(arrayStartIndex, endIndex);
                        const dataArray = new Function('return ' + jsonString)();
                        if (Array.isArray(dataArray) && dataArray[1]) {
                            let extractedCard = dataArray[1];
                            if (!extractedCard.id && extractedCard.data) {
                                extractedCard = extractedCard.data;
                            }
                            if (!extractedCard.id && extractedCard.card) {
                                extractedCard = extractedCard.card;
                            }
                            cardData = extractedCard;
                        }
                    }
                }
            } catch (e) {
                log.warn('Failed to parse RisuAI data array', e.message);
            }

            if (text.includes('/api/v1/download/charx-v3/')) {
                isCharX = true;
            }
        }
    });

    return { cardData, isCharX };
}

/**
 * Derive feature flags from RisuAI card definition
 */
function deriveRisuFeatureFlags(cardDef) {
    const flags = {
        hasAlternateGreetings: false,
        hasEmbeddedLorebook: false,
        hasLinkedLorebook: false,
        hasLorebook: false,
        hasExampleDialogues: false,
        hasSystemPrompt: false,
        hasGallery: false,
        hasEmbeddedImages: false,
        hasExpressions: false
    };

    try {
        const data = cardDef?.data || cardDef;
        if (!data) return flags;

        // Alternate greetings
        if (Array.isArray(data.alternate_greetings)) {
            flags.hasAlternateGreetings = data.alternate_greetings.some(
                g => typeof g === 'string' && g.trim().length > 0
            );
        }

        // Lorebook
        const book = data.character_book;
        if (book && Array.isArray(book.entries) && book.entries.length > 0) {
            flags.hasLorebook = true;
            flags.hasEmbeddedLorebook = true;
        }

        // Example dialogues
        if (typeof data.mes_example === 'string' && data.mes_example.trim().length > 0) {
            flags.hasExampleDialogues = true;
        }

        // System prompt
        if (typeof data.system_prompt === 'string' && data.system_prompt.trim().length > 0) {
            flags.hasSystemPrompt = true;
        }

        // Gallery (in extensions)
        if (data.extensions?.gallery && Array.isArray(data.extensions.gallery) && data.extensions.gallery.length > 0) {
            flags.hasGallery = true;
        }

        // Embedded images in greetings
        const hasImages = (text) => {
            if (!text) return false;
            return /!\[([^\]]*)\]\(([^)]+)\)/.test(text) || /<img[^>]+src=["']([^"']+)["'][^>]*>/i.test(text);
        };

        if (hasImages(data.first_mes)) {
            flags.hasEmbeddedImages = true;
        } else if (Array.isArray(data.alternate_greetings)) {
            flags.hasEmbeddedImages = data.alternate_greetings.some(g => hasImages(g));
        }

    } catch (error) {
        log.warn('Failed to derive feature flags', error.message);
    }

    return flags;
}

/**
 * Count tokens roughly (character count / 4)
 */
function estimateTokenCount(cardDef) {
    try {
        const data = cardDef?.data || cardDef;
        if (!data) return 0;

        let totalChars = 0;
        const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'];

        for (const field of fields) {
            if (typeof data[field] === 'string') {
                totalChars += data[field].length;
            }
        }

        // Alternate greetings
        if (Array.isArray(data.alternate_greetings)) {
            for (const g of data.alternate_greetings) {
                if (typeof g === 'string') totalChars += g.length;
            }
        }

        // Lorebook entries
        if (data.character_book?.entries) {
            for (const entry of data.character_book.entries) {
                if (entry.content) totalChars += entry.content.length;
            }
        }

        return Math.round(totalChars / 4);
    } catch (error) {
        return 0;
    }
}

/**
 * Process a single RisuAI card
 */
async function processRisuCard(node, config = {}) {
    const risuId = node.id;
    const { force = false } = config;

    if (isRisuaiBlacklisted(risuId)) {
        log.debug(`Skipping blacklisted RisuAI card ${risuId}`);
        return { success: false, reason: 'blacklisted' };
    }

    // Check cooldown (skip if we already tried this card recently)
    if (!force && isOnCooldown(risuId)) {
        log.debug(`Skipping RisuAI card ${risuId} (on cooldown)`);
        return { success: false, reason: 'cooldown' };
    }

    const db = getDatabase();

    // Check if card exists by sourceId
    const existing = db.prepare(
        'SELECT id, lastModified, sourceId FROM cards WHERE source = ? AND sourceId = ?'
    ).get('risuai', risuId);

    // Parse node date for comparison
    const nodeDate = parseRisuDate(node.date);

    // Skip if exists and not forcing, and not newer
    if (existing && !force) {
        const existingDate = new Date(existing.lastModified).getTime();
        const nodeTime = new Date(nodeDate).getTime();

        if (nodeTime <= existingDate) {
            log.debug(`RisuAI card ${risuId} unchanged, skipping`);
            return { success: false, reason: 'unchanged', dbId: existing.id };
        }
        log.info(`RisuAI card ${risuId} has update (${existing.lastModified} -> ${nodeDate})`);
    }

    // Determine database ID first (we need it for file paths)
    let dbId;
    if (existing) {
        dbId = existing.id;
    } else {
        const maxIdRow = db.prepare('SELECT MAX(id) as maxId FROM cards').get();
        dbId = (maxIdRow?.maxId || 0) + 1;
    }

    const dbIdStr = String(dbId);
    const prefix = dbIdStr.substring(0, 2);
    const targetDir = path.join(STATIC_DIR, prefix);
    ensureDir(targetDir);

    // Download in priority order: CharX → PNG → JSON-v3 → JSON-v2
    // Stop when we get a hit, always grab thumbnail
    let cardDef = null;
    let assetCount = 0;
    let savedFormat = null;

    // 1. Try CharX first (best format - has assets)
    log.info(`Trying CharX for ${risuId}`);
    const charxResult = await fetchRisuCharXFile(risuId);
    if (!charxResult.error && charxResult.buffer) {
        const charxData = extractFromCharX(charxResult.buffer);
        if (charxData && charxData.card) {
            cardDef = charxData.card;
            assetCount = charxData.assetCount;
            savedFormat = 'charx';
            log.info(`CharX OK for ${risuId} (${assetCount} assets)`);

            // Save CharX file
            const charxPath = path.join(targetDir, `${dbIdStr}.charx`);
            await fsp.writeFile(charxPath, charxResult.buffer);
            log.info(`Saved CharX: ${charxPath} (${(charxResult.buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        }
    }

    // 2. Try PNG if CharX failed (has embedded assets in PNG)
    if (!cardDef) {
        log.info(`Trying PNG for ${risuId}`);
        const pngResult = await fetchRisuPngV3(risuId);
        if (!pngResult.error && pngResult.buffer) {
            const { parseCard } = await import('@character-foundry/character-foundry/loader');
            try {
                const parsed = parseCard(pngResult.buffer, `${risuId}.png`);
                if (parsed && parsed.card) {
                    cardDef = parsed.card;
                    savedFormat = 'png';
                    log.info(`PNG OK for ${risuId}`);

                    // Save full PNG as .card.png (for download)
                    const fullPngPath = path.join(targetDir, `${dbIdStr}.card.png`);
                    await fsp.writeFile(fullPngPath, pngResult.buffer);
                    log.info(`Saved full PNG: ${fullPngPath} (${(pngResult.buffer.length / 1024 / 1024).toFixed(1)}MB)`);
                }
            } catch (parseErr) {
                log.debug(`PNG parse failed for ${risuId}: ${parseErr.message}`);
            }
        }
    }

    // 3. Try JSON-v3 if file formats failed
    if (!cardDef) {
        log.info(`Trying JSON-v3 for ${risuId}`);
        const jsonResult = await fetchRisuCardJson(risuId);
        if (!jsonResult.error && jsonResult.json) {
            cardDef = jsonResult.json;
            savedFormat = 'json';
            log.info(`JSON-v3 OK for ${risuId}`);
        }
    }

    // 4. Try JSON-v2 as last resort
    if (!cardDef) {
        log.info(`Trying JSON-v2 for ${risuId}`);
        const jsonV2Result = await fetchRisuCardJsonV2(risuId);
        if (!jsonV2Result.error && jsonV2Result.json) {
            cardDef = jsonV2Result.json;
            savedFormat = 'json';
            log.info(`JSON-v2 OK for ${risuId}`);
        }
    }

    // If nothing worked, set cooldown and bail
    if (!cardDef) {
        log.warn(`All download methods failed for ${risuId}`);
        setCooldown(risuId);
        return { success: false, reason: 'all_methods_failed' };
    }

    // Always fetch thumbnail for grid display
    const thumbnailResult = await fetchRisuThumbnail(node.img);
    if (thumbnailResult) {
        const thumbPath = path.join(targetDir, `${dbIdStr}.png`);
        await fsp.writeFile(thumbPath, thumbnailResult.buffer);
    }

    setCooldown(risuId);

    // Derive feature flags
    const flags = deriveRisuFeatureFlags(cardDef);

    // Also check node-level flags and asset count
    if (node.hasLore || node.haslore) {
        flags.hasLorebook = true;
        flags.hasEmbeddedLorebook = true;
    }
    if (node.hasEmotion) {
        flags.hasExpressions = true;
    }
    if (node.hasAsset || assetCount > 0) {
        flags.hasGallery = true;
        flags.assetCount = assetCount;
    }

    // Estimate token count
    const tokenCount = estimateTokenCount(cardDef);

    // Build metadata object
    const cardData = cardDef?.data || cardDef;
    const baseTags = Array.isArray(node.tags) ? node.tags : [];

    // Infer additional tags from card content
    const cardForTagging = {
        name: cardData?.name || node.name,
        description: cardData?.description || node.desc || '',
        tagline: node.desc?.substring(0, 200) || '',
        personality: cardData?.personality || '',
        scenario: cardData?.scenario || '',
        topics: baseTags,
        definition: cardDef
    };
    const inferredTags = inferTags(cardForTagging);
    const allTags = [...new Set([...baseTags, ...inferredTags])];

    if (inferredTags.length > 0) {
        log.debug(`Inferred ${inferredTags.length} tags for ${node.name}: ${inferredTags.slice(0, 5).join(', ')}${inferredTags.length > 5 ? '...' : ''}`);
    }

    const metadata = {
        id: dbId,
        name: cardData?.name || node.name || 'Unknown',
        description: cardData?.description || node.desc || '',
        tagline: node.desc?.substring(0, 200) || '',
        author: node.authorname || 'Anonymous',
        topics: allTags,
        nTokens: tokenCount,
        tokenCount: tokenCount,
        starCount: parseDownloadCount(node.download),
        n_favorites: 0,
        createdAt: nodeDate,
        lastActivityAt: nodeDate,
        fullPath: `risuai/${node.authorname || 'anonymous'}/${node.name || risuId}`,
        source: 'risuai',
        sourceId: risuId,
        sourcePath: `character/${risuId}`,
        sourceUrl: `${BASE_URL}/character/${risuId}`,
        visibility: node.hidden ? 'hidden' : 'public',
        ...flags,
        definition: cardDef
    };

    // Write JSON sidecar
    const jsonPath = path.join(targetDir, `${dbIdStr}.json`);
    await fsp.writeFile(jsonPath, JSON.stringify(metadata, null, 2));

    // Upsert to database
    upsertCard(metadata);

    log.info(`${existing ? 'Updated' : 'Imported'} RisuAI card: ${metadata.name} (${risuId} -> ${dbId})`);

    return {
        success: true,
        isNew: !existing,
        dbId,
        name: metadata.name
    };
}

/**
 * Fetch character list from RisuAI
 */
async function fetchRisuCardList(page = 1) {
    const url = `${BASE_URL}/?sort=latest&page=${page}`;
    try {
        const response = await rateLimitedRequest(url);
        const $ = cheerioLoad(response.data);

        const cards = [];

        // Find all character links and extract data
        $('a[href^="/character/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                cards.push({ url: href });
            }
        });

        return cards;
    } catch (error) {
        log.error(`Failed to fetch RisuAI list page ${page}`, error);
        return [];
    }
}

/**
 * Fetch and parse a single card page to get node data
 */
async function fetchRisuNode(cardUrl) {
    const fullUrl = `${BASE_URL}/${cardUrl.replace(/^\//, '')}`;

    try {
        const response = await rateLimitedRequest(fullUrl);
        const { cardData, isCharX } = parseRisuHtml(response.data);

        if (!cardData || !cardData.id) {
            log.warn(`No valid card data found for ${cardUrl}`);
            return null;
        }

        return {
            ...cardData,
            is_charx: isCharX,
            authorname: cardData.authorname || 'Anonymous',
            tags: Array.isArray(cardData.tags) ? cardData.tags : []
        };
    } catch (error) {
        log.error(`Failed to fetch RisuAI node ${cardUrl}`, error);
        return null;
    }
}

/**
 * Refresh a single RisuAI card by database ID
 */
export async function refreshRisuCard(dbId, config = {}) {
    const db = getDatabase();

    // Get card by database ID
    const card = db.prepare(
        'SELECT id, sourceId, source FROM cards WHERE id = ?'
    ).get(dbId);

    if (!card) {
        throw new Error(`Card ${dbId} not found`);
    }

    if (card.source !== 'risuai') {
        throw new Error(`Card ${dbId} is not a RisuAI card (source: ${card.source})`);
    }

    const risuId = card.sourceId;
    log.info(`Refreshing RisuAI card ${dbId} (sourceId: ${risuId})`);

    // Fetch fresh node data
    const node = await fetchRisuNode(`/character/${risuId}`);
    if (!node) {
        throw new Error(`Failed to fetch RisuAI card ${risuId}`);
    }

    // Force refresh
    const result = await processRisuCard(node, { ...config, force: true });

    if (!result.success) {
        throw new Error(`Failed to refresh: ${result.reason}`);
    }

    return result;
}

/**
 * Main sync function
 */
export async function syncRisuAi(config) {
    if (!config.risuAiSync?.enabled) {
        log.info('RisuAI sync disabled');
        return { success: true, newCards: 0, updatedCards: 0 };
    }

    log.info('Starting RisuAI sync...');
    loadRisuaiBlacklist();
    loadRisuaiCooldown();

    const pageLimit = config.risuAiSync?.pageLimit || 5;
    let newCards = 0;
    let updatedCards = 0;
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= pageLimit) {
        log.info(`Fetching RisuAI list page ${page}/${pageLimit}`);

        const cardLinks = await fetchRisuCardList(page);

        if (cardLinks.length === 0) {
            log.info(`No more cards on page ${page}, ending sync`);
            hasMore = false;
            break;
        }

        for (const { url } of cardLinks) {
            try {
                const node = await fetchRisuNode(url);
                if (!node) continue;

                const result = await processRisuCard(node, config);

                if (result.success) {
                    if (result.isNew) {
                        newCards++;
                    } else {
                        updatedCards++;
                    }
                }
            } catch (error) {
                log.error(`Error processing ${url}`, error);
            }
        }

        log.info(`Page ${page} complete. New: ${newCards}, Updated: ${updatedCards}`);
        page++;
    }

    // Save cooldown state at end of sync
    saveRisuaiCooldown();

    log.info(`RisuAI sync complete. New: ${newCards}, Updated: ${updatedCards}`);
    return { success: true, newCards, updatedCards };
}

export default {
    syncRisuAi,
    refreshRisuCard,
    processRisuCard,
    fetchRisuNode,
    loadRisuaiBlacklist
};
