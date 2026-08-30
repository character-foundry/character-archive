/**
 * ChubScraper - Scraper for Chub.ai characters
 *
 * This is the most complex scraper due to:
 * - PNG metadata embedding/extraction
 * - Fuzz detection and handling
 * - Definition merging from multiple sources (API, PNG, repository)
 * - Timeline vs search vs followed creators modes
 * - Concurrent processing with rate limiting
 *
 * This module wraps the existing scraper.js implementation to provide
 * the BaseScraper interface while preserving all the complex logic.
 */

import { BaseScraper } from './BaseScraper.js';
import {
    createChubClient,
    rateLimitedRequest,
    loadBlacklist as loadChubBlacklist,
    isBlacklisted as isChubBlacklisted
} from '../ApiClient.js';
import { syncLinkedLorebooks } from '../LorebookService.js';

// Import the existing complex implementation
import {
    downloadCard,
    refreshCard as chubRefreshCard,
    syncCards as chubSyncCards
} from '../scraper.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, '../../../static');

/**
 * Check if PNG is valid (has valid PNG signature)
 */
async function pngCheck(cardId) {
    const cardIdStr = String(cardId);
    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
    const filePath = path.join(subfolder, `${cardIdStr}.png`);

    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        const buffer = await fs.promises.readFile(filePath);
        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        return buffer.slice(0, 8).equals(pngSignature);
    } catch {
        return false;
    }
}

export class ChubScraper extends BaseScraper {
    constructor() {
        super({
            source: 'chub',
            displayName: 'Chub'
        });

        // Chub uses global blacklist from ApiClient
        this._useGlobalBlacklist = true;
    }

    // ==================== Override Blacklist ====================
    // Chub has its own blacklist in ApiClient.js

    loadBlacklist() {
        loadChubBlacklist();
        this.log.info('Loaded Chub blacklist from ApiClient');
    }

    isBlacklisted(sourceId) {
        return isChubBlacklisted(sourceId);
    }

    // ==================== Abstract Method Implementations ====================

    getSourceId(item) {
        return item.id;
    }

    getRemoteTimestamp(item) {
        return item.lastActivityAt || item.updatedAt || item.createdAt;
    }

    getImageRef(item, cardData) {
        return item.max_res_url || item.avatar_url;
    }

    /**
     * Fetch cards from Chub search API
     */
    async fetchList(page, config) {
        const client = createChubClient(config.chubApiKey);
        const syncLimit = config.syncLimit || 500;
        const sortBy = config.syncByNew ? 'created_at' : 'last_activity_at';

        const params = {
            search: '',
            first: syncLimit,
            page,
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

        if (config.topic) {
            params.topics = config.topic;
        }
        if (config.excludeTopic) {
            params.excludetopics = config.excludeTopic;
        }

        try {
            const response = await client.get('https://gateway.chub.ai/search', { params });
            return response.data?.data?.nodes || [];
        } catch (error) {
            this.log.error(`Failed to fetch Chub search page ${page}`, error.message);
            return [];
        }
    }

    /**
     * Fetch cards from timeline
     */
    async fetchTimeline(page, config) {
        if (!config.chubApiKey) {
            throw new Error('Timeline mode requires an API key');
        }

        const client = createChubClient(config.chubApiKey);
        const url = `https://gateway.chub.ai/api/timeline/v1?page=${page}&count=true`;

        try {
            const response = await rateLimitedRequest(url, { headers: client.defaults.headers });
            const nodes = response.data?.data?.nodes || [];

            // Filter to characters only
            return nodes.filter(card => card.projectSpace === 'characters');
        } catch (error) {
            this.log.error(`Failed to fetch timeline page ${page}`, error.message);
            return [];
        }
    }

    /**
     * Fetch cards from a specific creator
     */
    async fetchByCreator(username, page, config) {
        const client = createChubClient(config.chubApiKey);
        const syncLimit = config.syncLimit || 500;

        const params = {
            first: syncLimit,
            page,
            sort: 'created_at',
            asc: 'false',
            nsfw: 'true',
            nsfl: 'true',
            min_tokens: config.min_tokens || 50,
            username,
            namespace: 'characters',
            include_forks: 'true',
            exclude_mine: 'false'
        };

        try {
            const response = await client.get('https://gateway.chub.ai/search', { params });
            return response.data?.data?.nodes || [];
        } catch (error) {
            this.log.error(`Failed to fetch cards for creator ${username} page ${page}`, error.message);
            return [];
        }
    }

    /**
     * Fetch single card data
     */
    async fetchCard(sourceId) {
        try {
            const client = createChubClient();
            const response = await client.get(`https://gateway.chub.ai/api/characters/${sourceId}`);
            const payload = response.data;
            const card = payload?.node || payload?.data || payload;

            if (!card || !card.id) {
                return { data: null, error: 'Card not found' };
            }

            return { data: card, error: null };
        } catch (error) {
            return { data: null, error: error.message };
        }
    }

    /**
     * Fetch card image - handled by downloadCard's complex logic
     */
    async fetchImage(imageRef) {
        // Image fetching is handled by downloadCard's complex PNG logic
        // This is just a placeholder for the interface
        return null;
    }

    /**
     * Fetch ratings for a card
     */
    async fetchRatings(cardId, client) {
        try {
            const ratingsUrl = `https://gateway.chub.ai/api/project/${cardId}/ratings`;
            const response = await rateLimitedRequest(ratingsUrl, {
                headers: client.defaults.headers,
                timeout: 10000
            });

            return {
                ratingsEnabled: response.data.enabled !== false,
                ratings: response.data.ratings_map ? JSON.stringify(response.data.ratings_map) : null
            };
        } catch (error) {
            this.log.warn(`Failed to fetch ratings for ${cardId}`, error.message);
            return { ratingsEnabled: false, ratings: null };
        }
    }

    deriveFeatureFlags(cardDef) {
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

        if (!cardDef) return flags;

        const data = cardDef.data || cardDef;

        // Alternate greetings
        if (Array.isArray(data.alternate_greetings)) {
            flags.hasAlternateGreetings = data.alternate_greetings.some(
                g => typeof g === 'string' && g.trim().length > 0
            );
        }

        // Lorebook
        if (data.character_book?.entries?.length > 0) {
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

        // Gallery
        if (data.extensions?.gallery?.length > 0) {
            flags.hasGallery = true;
        }

        return flags;
    }

    async parseCardToMetadata(rawCard, dbId, listItem = null) {
        // Chub's downloadCard handles all the complex metadata building
        // This is provided for interface compliance but actual work is done in downloadCard
        return rawCard;
    }

    // ==================== Main Sync Methods ====================

    /**
     * Process a single card using existing complex logic
     */
    async processCard(item, config = {}) {
        const sourceId = this.getSourceId(item);

        // Check blacklist
        if (this.isBlacklisted(sourceId)) {
            this.log.debug(`Skipping blacklisted card ${sourceId}`);
            return { success: false, reason: 'blacklisted' };
        }

        // Skip forks if configured
        if (item.labels?.some(l => l.title === 'Forked')) {
            return { success: false, reason: 'forked' };
        }

        // Skip below minimum tokens
        if (config.min_tokens && item.nTokens < config.min_tokens) {
            return { success: false, reason: 'below_min_tokens' };
        }

        try {
            // Fetch ratings
            const client = createChubClient(config.chubApiKey);
            const { ratingsEnabled, ratings } = await this.fetchRatings(sourceId, client);
            item.ratingsEnabled = ratingsEnabled;
            if (ratings) {
                item.ratings = ratings;
            }

            // Use existing complex downloadCard logic
            const downloaded = await downloadCard(item, config, { force: config.force });

            return {
                success: downloaded,
                isNew: downloaded,
                dbId: sourceId,
                name: item.name
            };
        } catch (error) {
            this.log.error(`Error processing card ${sourceId}`, error);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Override sync to use Chub's complex multi-mode sync
     * This delegates to the existing chubSyncCards which handles:
     * - Timeline mode
     * - Search mode with topic cycling
     * - Followed creators mode
     * - Concurrent processing
     */
    async sync(config = {}, progressCallback = null) {
        this.log.info(`Starting Chub sync...`);
        this.loadBlacklist();

        // Delegate to existing complex sync logic
        return chubSyncCards({ ...config, skipSecondarySources: true }, progressCallback);
    }

    /**
     * Refresh a single card
     */
    async refreshCard(dbId, config = {}) {
        this.log.info(`Refreshing Chub card ${dbId}`);
        this.loadBlacklist();

        return chubRefreshCard(dbId, config);
    }

    /**
     * Check if PNG file is valid
     */
    async validatePng(cardId) {
        return pngCheck(cardId);
    }
}

// Export singleton instance
export const chubScraper = new ChubScraper();

// Export sync function for backwards compatibility
export async function syncChub(config, progressCallback = null) {
    const scraper = new ChubScraper();
    return scraper.sync(config, progressCallback);
}

// Export refresh function for backwards compatibility
export async function refreshChubCard(dbId, config = {}) {
    const scraper = new ChubScraper();
    return scraper.refreshCard(dbId, config);
}

export default ChubScraper;
