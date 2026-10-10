import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, upsertCard } from '../database.js';
import { logger } from '../utils/logger.js';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';
import { rateLimitedRequest } from './ApiClient.js';
import { inferTags } from '../utils/keyword-tagger.js';

const log = logger.scoped('WYVERN');
const fsp = fs.promises;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, '../../static');

const API_BASE = 'https://api.wyvern.chat';
const APP_BASE = 'https://app.wyvern.chat';

// Wyvern blacklist/cooldown files
const WYVERN_BLACKLIST_FILE = path.join(__dirname, '../../wyvern-blacklist.txt');
const WYVERN_COOLDOWN_FILE = path.join(__dirname, '../../wyvern-cooldown.json');

// Cooldown period - don't retry cards within this window (24 hours)
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

let wyvernBlacklist = new Set();
let wyvernCooldown = {}; // { wyvernId: timestamp }

function loadWyvernBlacklist() {
    try {
        if (fs.existsSync(WYVERN_BLACKLIST_FILE)) {
            const content = fs.readFileSync(WYVERN_BLACKLIST_FILE, 'utf8');
            wyvernBlacklist = new Set(
                content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'))
            );
            log.info(`Loaded ${wyvernBlacklist.size} Wyvern blacklisted cards`);
        }
    } catch (error) {
        log.warn('Failed to load Wyvern blacklist', error.message);
    }
}

function addToWyvernBlacklist(wyvernId, reason = '') {
    try {
        wyvernBlacklist.add(wyvernId);
        const entry = reason ? `${wyvernId} # ${reason}` : wyvernId;
        fs.appendFileSync(WYVERN_BLACKLIST_FILE, `${entry}\n`);
        log.info(`Added ${wyvernId} to Wyvern blacklist: ${reason}`);
    } catch (error) {
        log.warn(`Failed to add ${wyvernId} to blacklist`, error.message);
    }
}

function isWyvernBlacklisted(wyvernId) {
    return wyvernBlacklist.has(wyvernId);
}

function loadWyvernCooldown() {
    try {
        if (fs.existsSync(WYVERN_COOLDOWN_FILE)) {
            const content = fs.readFileSync(WYVERN_COOLDOWN_FILE, 'utf8');
            wyvernCooldown = JSON.parse(content);
            // Prune expired entries
            const now = Date.now();
            let pruned = 0;
            for (const [id, ts] of Object.entries(wyvernCooldown)) {
                if (now - ts > COOLDOWN_MS) {
                    delete wyvernCooldown[id];
                    pruned++;
                }
            }
            if (pruned > 0) {
                saveWyvernCooldown();
            }
            log.info(`Loaded ${Object.keys(wyvernCooldown).length} Wyvern cooldown entries (pruned ${pruned} expired)`);
        }
    } catch (error) {
        log.warn('Failed to load Wyvern cooldown', error.message);
        wyvernCooldown = {};
    }
}

function saveWyvernCooldown() {
    try {
        fs.writeFileSync(WYVERN_COOLDOWN_FILE, JSON.stringify(wyvernCooldown, null, 2));
    } catch (error) {
        log.warn('Failed to save Wyvern cooldown', error.message);
    }
}

function isOnCooldown(wyvernId) {
    const ts = wyvernCooldown[wyvernId];
    if (!ts) return false;
    return (Date.now() - ts) < COOLDOWN_MS;
}

function setCooldown(wyvernId) {
    wyvernCooldown[wyvernId] = Date.now();
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Create axios instance with Wyvern headers
 */
function createWyvernClient(bearerToken = null) {
    const headers = {
        'Origin': APP_BASE,
        'Referer': `${APP_BASE}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
    };

    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }

    return axios.create({
        timeout: 30000,
        headers
    });
}

/**
 * Fetch paginated character list from Wyvern explore API
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Items per page (max 100)
 * @param {object} options - sort, order, rating
 */
async function fetchWyvernList(page = 1, limit = 20, options = {}, bearerToken = null) {
    const { sort = 'dateCreated', order = 'DESC', rating = 'explicit' } = options;

    const url = `${API_BASE}/exploreSearch/characters`;
    const params = { page, limit, sort, order, rating };

    try {
        const client = createWyvernClient(bearerToken);
        const response = await client.get(url, { params });

        return {
            results: response.data.results || [],
            total: response.data.total || 0,
            totalPages: response.data.totalPages || 0,
            hasMore: response.data.hasMore || false,
            page: response.data.page || page
        };
    } catch (error) {
        log.error(`Failed to fetch Wyvern list page ${page}`, error.message);
        return { results: [], total: 0, totalPages: 0, hasMore: false, page };
    }
}

/**
 * Fetch full character data from Wyvern API
 */
async function fetchWyvernCharacter(wyvernId, bearerToken = null) {
    const url = `${API_BASE}/characters/${wyvernId}`;

    try {
        const client = createWyvernClient(bearerToken);
        const response = await client.get(url);
        return { data: response.data, error: null };
    } catch (error) {
        const status = error?.response?.status;
        return { data: null, error: error.message, status };
    }
}

/**
 * Fetch image through Wyvern's image proxy (returns JSON with base64 image)
 */
async function fetchWyvernImage(imageUrl) {
    if (!imageUrl) return null;

    // Use Wyvern's image proxy - returns {"image":"data:image/png;base64,..."}
    const proxyUrl = `${APP_BASE}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;

    try {
        const response = await axios.get(proxyUrl, {
            responseType: 'json',
            timeout: 30000,
            headers: {
                'Origin': APP_BASE,
                'Referer': `${APP_BASE}/`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Response is {"image":"data:image/png;base64,..."}
        const dataUrl = response.data?.image;
        if (!dataUrl || !dataUrl.startsWith('data:')) {
            log.warn(`Invalid image proxy response for: ${imageUrl}`);
            return null;
        }

        // Extract base64 part after the comma
        const base64Part = dataUrl.split(',')[1];
        if (!base64Part) {
            log.warn(`No base64 data in image proxy response for: ${imageUrl}`);
            return null;
        }

        return Buffer.from(base64Part, 'base64');
    } catch (error) {
        log.warn(`Failed to fetch image via proxy: ${imageUrl}`, error.message);
        return null;
    }
}

/**
 * Derive feature flags from Wyvern character data
 */
function deriveWyvernFeatureFlags(charData) {
    const flags = {
        hasAlternateGreetings: false,
        hasLorebook: false,
        hasEmbeddedLorebook: false,
        hasLinkedLorebook: false,
        hasExampleDialogues: false,
        hasSystemPrompt: false,
        hasGallery: false,
        hasEmbeddedImages: false,
        hasExpressions: false
    };

    if (!charData) return flags;

    // Check alternate greetings
    if (Array.isArray(charData.alternate_greetings) && charData.alternate_greetings.length > 0) {
        flags.hasAlternateGreetings = true;
    }

    // Check lorebooks
    if (Array.isArray(charData.lorebooks) && charData.lorebooks.length > 0) {
        flags.hasLorebook = true;
        flags.hasEmbeddedLorebook = true;
    }

    // Check example dialogues
    if (charData.mes_example && charData.mes_example.trim().length > 0) {
        flags.hasExampleDialogues = true;
    }

    // Check system prompt (Wyvern uses pre_history_instructions or post_history_instructions)
    if ((charData.pre_history_instructions && charData.pre_history_instructions.trim().length > 0) ||
        (charData.post_history_instructions && charData.post_history_instructions.trim().length > 0)) {
        flags.hasSystemPrompt = true;
    }

    // Check gallery
    if (Array.isArray(charData.gallery) && charData.gallery.length > 0) {
        flags.hasGallery = true;
    }

    // Check sprites/expressions
    if (charData.sprite_set || (Array.isArray(charData.sprite_sets) && charData.sprite_sets.length > 0)) {
        flags.hasExpressions = true;
    }

    return flags;
}

/**
 * Estimate token count from character data
 */
function estimateTokenCount(charData) {
    if (!charData) return 0;

    let totalChars = 0;

    const textFields = [
        'description', 'personality', 'scenario', 'first_mes',
        'mes_example', 'pre_history_instructions', 'post_history_instructions',
        'visual_description', 'creator_notes'
    ];

    for (const field of textFields) {
        if (charData[field] && typeof charData[field] === 'string') {
            totalChars += charData[field].length;
        }
    }

    // Alternate greetings
    if (Array.isArray(charData.alternate_greetings)) {
        for (const greeting of charData.alternate_greetings) {
            if (typeof greeting === 'string') {
                totalChars += greeting.length;
            }
        }
    }

    // Lorebook entries
    if (Array.isArray(charData.lorebooks)) {
        for (const lorebook of charData.lorebooks) {
            if (lorebook.entries && Array.isArray(lorebook.entries)) {
                for (const entry of lorebook.entries) {
                    if (entry.content) totalChars += entry.content.length;
                }
            }
        }
    }

    return Math.round(totalChars / 4);
}

/**
 * Build CCv2-compatible card definition from Wyvern data
 */
function buildCardDefinition(charData) {
    // Wyvern already uses CCv2-like field names, just need to structure it
    const data = {
        name: charData.name || 'Unknown',
        description: charData.description || '',
        personality: charData.personality || '',
        scenario: charData.scenario || '',
        first_mes: charData.first_mes || '',
        mes_example: charData.mes_example || '',
        alternate_greetings: charData.alternate_greetings || [],
        tags: charData.tags || [],
        creator_notes: charData.creator_notes || '',
        system_prompt: charData.pre_history_instructions || '',
        post_history_instructions: charData.post_history_instructions || '',
        extensions: {
            visual_description: charData.visual_description || '',
            wyvern: {
                id: charData.id,
                rating: charData.rating,
                sprite_set: charData.sprite_set,
                commands: charData.commands,
                scripts: charData.scripts
            }
        }
    };

    // Map lorebooks to character_book
    if (Array.isArray(charData.lorebooks) && charData.lorebooks.length > 0) {
        const allEntries = [];
        for (const lb of charData.lorebooks) {
            if (lb.entries && Array.isArray(lb.entries)) {
                allEntries.push(...lb.entries);
            }
        }
        if (allEntries.length > 0) {
            data.character_book = {
                entries: allEntries
            };
        }
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data
    };
}

/**
 * Process a single Wyvern character
 */
async function processWyvernCard(listItem, config = {}) {
    const wyvernId = listItem.id || listItem._id;
    const { force = false, bearerToken = null } = config;

    if (isWyvernBlacklisted(wyvernId)) {
        log.debug(`Skipping blacklisted Wyvern card ${wyvernId}`);
        return { success: false, reason: 'blacklisted' };
    }

    if (!force && isOnCooldown(wyvernId)) {
        log.debug(`Skipping Wyvern card ${wyvernId} (on cooldown)`);
        return { success: false, reason: 'cooldown' };
    }

    const db = getDatabase();

    // Check if card exists by sourceId
    const existing = db.prepare(
        'SELECT id, lastModified, sourceId FROM cards WHERE source = ? AND sourceId = ?'
    ).get('wyvern', wyvernId);

    // Parse dates
    const remoteUpdated = listItem.updated_at || listItem.created_at;

    // Skip if exists and not forcing, and not newer
    if (existing && !force) {
        const existingDate = new Date(existing.lastModified).getTime();
        const remoteTime = new Date(remoteUpdated).getTime();

        if (remoteTime <= existingDate) {
            log.debug(`Wyvern card ${wyvernId} unchanged, skipping`);
            return { success: false, reason: 'unchanged', dbId: existing.id };
        }
        log.info(`Wyvern card ${wyvernId} has update (${existing.lastModified} -> ${remoteUpdated})`);
    }

    // Fetch full character data
    const { data: charData, error } = await fetchWyvernCharacter(wyvernId, bearerToken);
    if (error || !charData) {
        log.warn(`Failed to fetch Wyvern card ${wyvernId}: ${error}`);
        setCooldown(wyvernId);
        return { success: false, reason: 'fetch_failed', error };
    }

    // Determine database ID
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

    // Fetch avatar image
    if (charData.avatar) {
        const imageBuffer = await fetchWyvernImage(charData.avatar);
        if (imageBuffer) {
            const imagePath = path.join(targetDir, `${dbIdStr}.png`);
            await fsp.writeFile(imagePath, imageBuffer);
            log.debug(`Saved avatar for ${wyvernId}`);
        }
    }

    setCooldown(wyvernId);

    // Derive feature flags
    const flags = deriveWyvernFeatureFlags(charData);

    // Estimate token count
    const tokenCount = estimateTokenCount(charData);

    // Build card definition
    const cardDef = buildCardDefinition(charData);

    // Get tags - combine from charData
    const baseTags = Array.isArray(charData.tags) ? charData.tags : [];

    // Infer additional tags
    const cardForTagging = {
        name: charData.name,
        description: charData.description || '',
        tagline: charData.description?.substring(0, 200) || '',
        personality: charData.personality || '',
        scenario: charData.scenario || '',
        topics: baseTags,
        definition: cardDef
    };
    const inferredTags = inferTags(cardForTagging);
    // Always add 'wyvern' tag for filtering/sorting
    const allTags = [...new Set(['wyvern', ...baseTags, ...inferredTags])];

    // Map Wyvern stats to our DB fields
    const stats = charData.statistics_record || charData.entity_statistics || {};

    const metadata = {
        id: dbId,
        name: charData.name || 'Unknown',
        tagline: charData.description?.substring(0, 200) || '',
        author: charData.creator?.displayName || charData.creator?.uid || 'Anonymous',
        topics: allTags,
        nTokens: tokenCount,
        tokenCount: tokenCount,
        // Map Wyvern stats to Chub-like fields
        starCount: stats.likes || 0,
        n_favorites: stats.follows || 0,
        nChats: stats.views || 0,
        nMessages: stats.messages || 0,
        rating: charData.rating === 'explicit' ? 1 : charData.rating === 'suggestive' ? 0.5 : 0,
        createdAt: charData.created_at || new Date().toISOString(),
        lastModified: charData.updated_at || charData.created_at || new Date().toISOString(),
        lastActivityAt: charData.updated_at || charData.created_at || new Date().toISOString(),
        fullPath: `wyvern/${charData.creator?.displayName || 'anonymous'}/${charData.name || wyvernId}`,
        source: 'wyvern',
        sourceId: wyvernId,
        sourcePath: `characters/${wyvernId}`,
        sourceUrl: `${APP_BASE}/characters/${wyvernId}`,
        visibility: charData.visibility || 'public',
        ...flags,
        definition: cardDef
    };

    // Write JSON sidecar
    const jsonPath = path.join(targetDir, `${dbIdStr}.json`);
    await fsp.writeFile(jsonPath, JSON.stringify(metadata, null, 2));

    // Upsert to database
    upsertCard(metadata);

    log.info(`${existing ? 'Updated' : 'Imported'} Wyvern card: ${metadata.name} (${wyvernId} -> ${dbId})`);

    return {
        success: true,
        isNew: !existing,
        dbId,
        name: metadata.name
    };
}

/**
 * Main sync function
 */
export async function syncWyvern(config, progressCallback = null) {
    if (!config.wyvernSync?.enabled) {
        log.info('Wyvern sync disabled');
        return { success: true, newCards: 0, updatedCards: 0 };
    }

    log.info('Starting Wyvern sync...');
    loadWyvernBlacklist();
    loadWyvernCooldown();

    const pageLimit = config.wyvernSync?.pageLimit || 10;
    const itemsPerPage = config.wyvernSync?.itemsPerPage || 50;
    const bearerToken = config.wyvernSync?.bearerToken || null;
    const rating = config.wyvernSync?.rating || 'explicit'; // Get all ratings

    let newCards = 0;
    let updatedCards = 0;
    let page = 1;
    let hasMore = true;
    let processedCount = 0;

    if (progressCallback) {
        progressCallback({ progress: 0, currentCard: '[Wyvern] Starting sync...' });
    }

    while (hasMore && page <= pageLimit) {
        log.info(`Fetching Wyvern list page ${page}/${pageLimit}`);

        const listResult = await fetchWyvernList(page, itemsPerPage, { rating }, bearerToken);

        if (!listResult.results || listResult.results.length === 0) {
            log.info('No more results from Wyvern');
            break;
        }

        log.info(`Processing ${listResult.results.length} cards from page ${page} (total: ${listResult.total})`);

        for (const item of listResult.results) {
            try {
                const result = await processWyvernCard(item, { bearerToken });
                processedCount++;

                if (result.success) {
                    if (result.isNew) {
                        newCards++;
                    } else {
                        updatedCards++;
                    }

                    if (progressCallback) {
                        const progress = Math.round((page / pageLimit) * 100);
                        progressCallback({
                            progress,
                            currentCard: `[Wyvern] ${result.name || item.name || item.id}`,
                            newCards
                        });
                    }
                }
            } catch (error) {
                log.error(`Error processing Wyvern card ${item.id}`, error);
            }

            // Small delay between cards to be nice
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        hasMore = listResult.hasMore;
        page++;

        // Save cooldown periodically
        if (page % 5 === 0) {
            saveWyvernCooldown();
        }
    }

    // Final save
    saveWyvernCooldown();

    log.info(`Wyvern sync complete: ${newCards} new, ${updatedCards} updated`);

    return { success: true, newCards, updatedCards };
}

/**
 * Refresh a single Wyvern card by database ID
 */
export async function refreshWyvernCard(dbId, config = {}) {
    const db = getDatabase();

    const card = db.prepare(
        'SELECT id, sourceId, source FROM cards WHERE id = ?'
    ).get(dbId);

    if (!card) {
        throw new Error(`Card ${dbId} not found`);
    }

    if (card.source !== 'wyvern') {
        throw new Error(`Card ${dbId} is not a Wyvern card (source: ${card.source})`);
    }

    const wyvernId = card.sourceId;
    log.info(`Refreshing Wyvern card ${dbId} (sourceId: ${wyvernId})`);

    const { data: charData, error } = await fetchWyvernCharacter(wyvernId, config.bearerToken);
    if (error || !charData) {
        throw new Error(`Failed to fetch Wyvern card ${wyvernId}: ${error}`);
    }

    const result = await processWyvernCard(charData, { ...config, force: true });

    if (!result.success) {
        throw new Error(`Failed to refresh: ${result.reason}`);
    }

    return result;
}

export { fetchWyvernList, fetchWyvernCharacter, fetchWyvernImage };
