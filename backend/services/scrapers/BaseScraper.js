/**
 * BaseScraper - Abstract base class for all character scrapers
 *
 * Provides common infrastructure:
 * - Blacklist management (persistent file-based)
 * - Cooldown tracking (JSON file with expiry)
 * - File operations (directory creation, PNG/JSON/CharX writing)
 * - Database operations (check existing, get next ID, upsert)
 * - Progress reporting
 *
 * Concrete scrapers only need to implement:
 * - fetchList(page, config) - Get list of cards from source
 * - fetchCard(sourceId) - Fetch single card data
 * - fetchImage(imageRef) - Download card image
 * - parseCardToMetadata(rawCard, dbId) - Convert to our metadata format
 * - deriveFeatureFlags(cardDef) - Extract feature flags from card definition
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getDatabase, upsertCard } from '../../database.js';
import { logger } from '../../utils/logger.js';
import { lockService } from '../LockService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = process.env.CHARACTER_ARCHIVE_STATIC_DIR || path.join(PROJECT_ROOT, 'static');
const DATA_DIR = process.env.CHARACTER_ARCHIVE_DATA_DIR || path.join(PROJECT_ROOT, 'data');

function timestampToArchiveSecond(value) {
    if (value instanceof Date) {
        const milliseconds = value.getTime();
        return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
    }

    if (typeof value !== 'string' && typeof value !== 'number') return null;
    let normalized = value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
        normalized = `${value.replace(' ', 'T')}Z`;
    }
    const milliseconds = new Date(normalized).getTime();
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

export function isRemoteTimestampNewer(existingTimestamp, remoteTimestamp) {
    const existingSecond = timestampToArchiveSecond(existingTimestamp);
    const remoteSecond = timestampToArchiveSecond(remoteTimestamp);
    if (existingSecond === null || remoteSecond === null) return true;
    return remoteSecond > existingSecond;
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class BaseScraper {
    /**
     * @param {object} config - Scraper configuration
     * @param {string} config.source - Source identifier (e.g., 'chub', 'risuai', 'wyvern', 'ct')
     * @param {string} config.displayName - Human-readable name (e.g., 'RisuAI', 'Wyvern')
     * @param {string} [config.blacklistFile] - Path to blacklist file (defaults to data/{source}-blacklist.txt)
     * @param {string} [config.cooldownFile] - Path to cooldown file (defaults to data/{source}-cooldown.json)
     * @param {number} [config.cooldownMs] - Cooldown period in ms (defaults to 24 hours)
     */
    constructor(config) {
        this.source = config.source;
        this.displayName = config.displayName || config.source;
        this.blacklistFile = config.blacklistFile || path.join(DATA_DIR, `${config.source}-blacklist.txt`);
        this.cooldownFile = config.cooldownFile || path.join(DATA_DIR, `${config.source}-cooldown.json`);
        this.cooldownMs = config.cooldownMs || 24 * 60 * 60 * 1000; // 24 hours default
        this.log = logger.scoped(this.displayName.toUpperCase());

        this._blacklist = new Set();
        this._cooldown = {};
        this._cooldownDirty = false;
    }

    // ==================== Blacklist Management ====================

    loadBlacklist() {
        try {
            if (fs.existsSync(this.blacklistFile)) {
                const content = fs.readFileSync(this.blacklistFile, 'utf8');
                this._blacklist = new Set(
                    content.split('\n')
                        .map(line => line.split('#')[0].trim()) // Strip comments
                        .filter(line => line.length > 0)
                );
                this.log.info(`Loaded ${this._blacklist.size} blacklisted cards`);
            }
        } catch (error) {
            this.log.warn('Failed to load blacklist', error.message);
        }
    }

    isBlacklisted(sourceId) {
        return this._blacklist.has(String(sourceId));
    }

    addToBlacklist(sourceId, reason = '') {
        try {
            const id = String(sourceId);
            this._blacklist.add(id);
            const entry = reason ? `${id} # ${reason}` : id;
            fs.appendFileSync(this.blacklistFile, `${entry}\n`);
            this.log.info(`Added ${id} to blacklist: ${reason || 'no reason'}`);
        } catch (error) {
            this.log.warn(`Failed to add ${sourceId} to blacklist`, error.message);
        }
    }

    // ==================== Cooldown Management ====================

    loadCooldown() {
        try {
            if (fs.existsSync(this.cooldownFile)) {
                const content = fs.readFileSync(this.cooldownFile, 'utf8');
                this._cooldown = JSON.parse(content);

                // Prune expired entries
                const now = Date.now();
                let pruned = 0;
                for (const [id, ts] of Object.entries(this._cooldown)) {
                    if (now - ts > this.cooldownMs) {
                        delete this._cooldown[id];
                        pruned++;
                    }
                }

                if (pruned > 0) {
                    this.saveCooldown();
                }

                this.log.info(`Loaded ${Object.keys(this._cooldown).length} cooldown entries (pruned ${pruned} expired)`);
            }
        } catch (error) {
            this.log.warn('Failed to load cooldown', error.message);
            this._cooldown = {};
        }
    }

    isOnCooldown(sourceId) {
        const ts = this._cooldown[String(sourceId)];
        if (!ts) return false;
        return (Date.now() - ts) < this.cooldownMs;
    }

    setCooldown(sourceId) {
        this._cooldown[String(sourceId)] = Date.now();
        this._cooldownDirty = true;
    }

    saveCooldown() {
        try {
            fs.writeFileSync(this.cooldownFile, JSON.stringify(this._cooldown, null, 2));
            this._cooldownDirty = false;
        } catch (error) {
            this.log.warn('Failed to save cooldown', error.message);
        }
    }

    // ==================== File Operations ====================

    /**
     * Ensure card directory exists and return paths
     */
    getCardDir(dbId) {
        const dbIdStr = String(dbId);
        const prefix = dbIdStr.substring(0, 2);
        const cardDir = path.join(STATIC_DIR, prefix);

        if (!fs.existsSync(cardDir)) {
            fs.mkdirSync(cardDir, { recursive: true });
        }

        return {
            dir: cardDir,
            prefix,
            pngPath: path.join(cardDir, `${dbIdStr}.png`),
            jsonPath: path.join(cardDir, `${dbIdStr}.json`),
            fullPngPath: path.join(cardDir, `${dbIdStr}.card.png`),
            charxPath: path.join(cardDir, `${dbIdStr}.charx`)
        };
    }

    /**
     * Write card files to disk
     */
    async writeCardFiles(dbId, files = {}) {
        const paths = this.getCardDir(dbId);
        const written = [];
        const staged = [];

        try {
            const candidates = [
                ['png', paths.pngPath, files.png],
                ['fullPng', paths.fullPngPath, files.fullPng],
                ['charx', paths.charxPath, files.charx],
                ['json', paths.jsonPath, files.json == null
                    ? null
                    : typeof files.json === 'string' ? files.json : `${JSON.stringify(files.json, null, 2)}\n`]
            ];
            for (const [label, targetPath, content] of candidates) {
                if (content == null) continue;
                const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
                const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
                try {
                    await handle.writeFile(content);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                staged.push({ label, targetPath, temporaryPath });
            }
            for (const entry of staged) {
                await fs.promises.rename(entry.temporaryPath, entry.targetPath);
                written.push(entry.label);
            }
        } catch (error) {
            await Promise.allSettled(staged.map(entry => fs.promises.unlink(entry.temporaryPath)));
            this.log.error(`Failed to write files for card ${dbId}`, error);
            throw error;
        }

        return { paths, written };
    }

    // ==================== Database Operations ====================

    /**
     * Check if card already exists in database by source ID
     */
    checkExisting(sourceId) {
        const db = getDatabase();
        return db.prepare(
            'SELECT id, lastModified, sourceId FROM cards WHERE source = ? AND sourceId = ?'
        ).get(this.source, String(sourceId));
    }

    /**
     * Get next available database ID
     */
    getNextDbId() {
        const db = getDatabase();
        const maxIdRow = db.prepare('SELECT MAX(id) as maxId FROM cards').get();
        return (maxIdRow?.maxId || 0) + 1;
    }

    /**
     * Upsert card to database
     */
    upsertCard(metadata) {
        return upsertCard(metadata);
    }

    // ==================== Progress Reporting ====================

    reportProgress(callback, data) {
        if (typeof callback === 'function') {
            callback({
                source: this.source,
                displayName: this.displayName,
                ...data
            });
        }
    }

    // ==================== Abstract Methods ====================
    // These MUST be implemented by concrete scrapers

    /**
     * Fetch list of cards from the source
     * @param {number} page - Page number (1-based)
     * @param {object} config - Scraper configuration
     * @returns {Promise<Array>} Array of card items from source
     */
    async fetchList(page, config) {
        throw new Error(`${this.displayName}: fetchList() not implemented`);
    }

    /**
     * Fetch full card data from source
     * @param {string} sourceId - Source-specific card ID
     * @returns {Promise<{data: object|null, error: string|null}>}
     */
    async fetchCard(sourceId) {
        throw new Error(`${this.displayName}: fetchCard() not implemented`);
    }

    /**
     * Download card image
     * @param {string} imageRef - Image reference (URL, hash, etc.)
     * @returns {Promise<Buffer|null>}
     */
    async fetchImage(imageRef) {
        throw new Error(`${this.displayName}: fetchImage() not implemented`);
    }

    /**
     * Get source ID from list item
     * @param {object} item - Item from fetchList result
     * @returns {string}
     */
    getSourceId(item) {
        throw new Error(`${this.displayName}: getSourceId() not implemented`);
    }

    /**
     * Get remote timestamp for comparison
     * @param {object} item - Item from fetchList or fetchCard
     * @returns {Date|string|null}
     */
    getRemoteTimestamp(item) {
        throw new Error(`${this.displayName}: getRemoteTimestamp() not implemented`);
    }

    /**
     * Parse raw card data into our metadata format
     * @param {object} rawCard - Raw card data from source
     * @param {number} dbId - Database ID to use
     * @param {object} listItem - Original list item (may have additional metadata)
     * @returns {Promise<object>} Metadata object ready for upsertCard
     */
    async parseCardToMetadata(rawCard, dbId, listItem = null) {
        throw new Error(`${this.displayName}: parseCardToMetadata() not implemented`);
    }

    /**
     * Derive feature flags from card definition
     * @param {object} cardDef - Card definition/spec
     * @returns {object} Feature flags object
     */
    deriveFeatureFlags(cardDef) {
        throw new Error(`${this.displayName}: deriveFeatureFlags() not implemented`);
    }

    // ==================== Main Sync Loop ====================

    /**
     * Process a single card
     * @param {object} item - Item from fetchList
     * @param {object} config - Sync configuration
     * @returns {Promise<{success: boolean, reason?: string, isNew?: boolean, dbId?: number, name?: string}>}
     */
    async processCard(item, config = {}) {
        const sourceId = this.getSourceId(item);
        const { force = false } = config;

        // Check blacklist
        if (this.isBlacklisted(sourceId)) {
            this.log.debug(`Skipping blacklisted card ${sourceId}`);
            return { success: false, reason: 'blacklisted' };
        }

        // Check cooldown
        if (!force && this.isOnCooldown(sourceId)) {
            this.log.debug(`Skipping card ${sourceId} (on cooldown)`);
            return { success: false, reason: 'cooldown' };
        }

        // Check existing
        const existing = this.checkExisting(sourceId);
        const remoteTimestamp = this.getRemoteTimestamp(item);

        // Skip if exists and not newer (unless forcing)
        if (existing && !force && remoteTimestamp) {
            if (!isRemoteTimestampNewer(existing.lastModified, remoteTimestamp)) {
                this.log.debug(`Card ${sourceId} unchanged, skipping`);
                return { success: false, reason: 'unchanged', dbId: existing.id };
            }
            this.log.info(`Card ${sourceId} has update (${existing.lastModified} -> ${remoteTimestamp})`);
        }

        // Determine database ID
        const dbId = existing?.id || this.getNextDbId();

        try {
            // Fetch full card data (may already be in item for some sources)
            let cardData = item;
            if (typeof this.fetchCard === 'function' && this.fetchCard !== BaseScraper.prototype.fetchCard) {
                const fetchResult = await this.fetchCard(sourceId);
                if (fetchResult.error || !fetchResult.data) {
                    this.log.warn(`Failed to fetch card ${sourceId}: ${fetchResult.error}`);
                    this.setCooldown(sourceId);
                    return { success: false, reason: 'fetch_failed', error: fetchResult.error };
                }
                cardData = fetchResult.data;
            }

            // Parse to metadata
            const metadata = await this.parseCardToMetadata(cardData, dbId, item);

            // Fetch image if needed
            const imageRef = this.getImageRef ? this.getImageRef(item, cardData) : null;
            let imageBuffer = null;
            if (imageRef) {
                imageBuffer = await this.fetchImage(imageRef);
            }

            // Write files
            const filesToWrite = { json: metadata };
            if (imageBuffer) {
                filesToWrite.png = imageBuffer;
            }

            await this.writeCardFiles(dbId, filesToWrite);

            // Update cooldown
            this.setCooldown(sourceId);

            // Upsert to database
            this.upsertCard(metadata);

            const cardName = metadata.name || sourceId;
            this.log.info(`${existing ? 'Updated' : 'Imported'} card: ${cardName} (${sourceId} -> ${dbId})`);

            return {
                success: true,
                isNew: !existing,
                dbId,
                name: cardName
            };
        } catch (error) {
            this.log.error(`Error processing card ${sourceId}`, error);
            this.setCooldown(sourceId);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Main sync function - fetches and processes cards
     * @param {object} config - Sync configuration (source-specific)
     * @param {function} [progressCallback] - Progress callback
     * @returns {Promise<{success: boolean, newCards: number, updatedCards: number, errors: number}>}
     */
    async sync(config = {}, progressCallback = null) {
        const pageLimit = config.pageLimit || 10;
        const startPage = config.startPage || 1;

        this.log.info(`Starting ${this.displayName} sync (pages ${startPage}-${pageLimit})...`);

        // Load state
        this.loadBlacklist();
        this.loadCooldown();

        let newCards = 0;
        let updatedCards = 0;
        let errors = 0;
        let page = startPage;
        let hasMore = true;

        this.reportProgress(progressCallback, {
            progress: 0,
            currentCard: `[${this.displayName}] Starting sync...`,
            newCards: 0
        });

        while (hasMore && page <= pageLimit) {
            // Check for abort (main sync or CT sync depending on source)
            const isAborted = this.source === 'ct'
                ? lockService.isCtSyncAborted()
                : lockService.isSyncAborted();
            if (isAborted) {
                this.log.info(`${this.displayName} sync aborted by user`);
                this.reportProgress(progressCallback, {
                    progress: 100,
                    currentCard: `[${this.displayName}] Sync cancelled`,
                    newCards,
                    cancelled: true
                });
                break;
            }

            this.log.info(`Fetching page ${page}/${pageLimit}`);

            const items = await this.fetchList(page, config);

            if (!items || items.length === 0) {
                this.log.info(`No more items on page ${page}, ending sync`);
                hasMore = false;
                break;
            }

            this.log.info(`Processing ${items.length} cards from page ${page}`);

            for (const item of items) {
                // Check for abort before each card
                const isAbortedMid = this.source === 'ct'
                    ? lockService.isCtSyncAborted()
                    : lockService.isSyncAborted();
                if (isAbortedMid) {
                    this.log.info(`${this.displayName} sync aborted by user (mid-page)`);
                    break;
                }

                const result = await this.processCard(item, config);

                if (result.success) {
                    if (result.isNew) {
                        newCards++;
                    } else {
                        updatedCards++;
                    }

                    this.reportProgress(progressCallback, {
                        progress: Math.round((page / pageLimit) * 100),
                        currentCard: `[${this.displayName}] ${result.name || this.getSourceId(item)}`,
                        newCards
                    });
                } else if (['error', 'fetch_failed', 'node_fetch_failed'].includes(result.reason)) {
                    errors++;
                }

                // Small delay between cards to be nice to APIs
                await this.delay(config.delayMs || 100);
            }

            this.log.info(`Page ${page} complete. New: ${newCards}, Updated: ${updatedCards}, Errors: ${errors}`);
            page++;

            // Save cooldown periodically
            if (this._cooldownDirty && page % 5 === 0) {
                this.saveCooldown();
            }
        }

        // Final save
        if (this._cooldownDirty) {
            this.saveCooldown();
        }

        this.log.info(`${this.displayName} sync complete. New: ${newCards}, Updated: ${updatedCards}, Errors: ${errors}`);

        return { success: true, newCards, updatedCards, errors };
    }

    /**
     * Refresh a single card by database ID
     * @param {number} dbId - Database ID
     * @param {object} [config] - Additional configuration
     */
    async refreshCard(dbId, config = {}) {
        const db = getDatabase();
        const card = db.prepare(
            'SELECT id, sourceId, source FROM cards WHERE id = ?'
        ).get(dbId);

        if (!card) {
            throw new Error(`Card ${dbId} not found`);
        }

        if (card.source !== this.source) {
            throw new Error(`Card ${dbId} is not a ${this.displayName} card (source: ${card.source})`);
        }

        this.log.info(`Refreshing card ${dbId} (sourceId: ${card.sourceId})`);

        // Create a fake list item with just the source ID
        const fakeItem = { id: card.sourceId, _id: card.sourceId };

        const result = await this.processCard(fakeItem, { ...config, force: true });

        if (!result.success) {
            throw new Error(`Failed to refresh: ${result.reason}`);
        }

        return result;
    }

    // ==================== Utility Methods ====================

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default BaseScraper;
