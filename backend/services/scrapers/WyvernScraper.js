/**
 * WyvernScraper - Scraper for Wyvern.chat characters
 *
 * Extends BaseScraper with Wyvern-specific:
 * - API client with proper headers
 * - Image proxy handling (Wyvern returns base64 JSON)
 * - CCv2-compatible card definition building
 */

import axios from 'axios';
import { BaseScraper } from './BaseScraper.js';
import { inferTags } from '../../utils/keyword-tagger.js';

const API_BASE = 'https://api.wyvern.chat';
const APP_BASE = 'https://app.wyvern.chat';

export class WyvernScraper extends BaseScraper {
    constructor() {
        super({
            source: 'wyvern',
            displayName: 'Wyvern'
        });
    }

    // ==================== API Client ====================

    createClient(bearerToken = null) {
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

    // ==================== Abstract Method Implementations ====================

    getSourceId(item) {
        return item.id || item._id;
    }

    getRemoteTimestamp(item) {
        return item.updated_at || item.created_at;
    }

    getImageRef(item, cardData) {
        return cardData?.avatar || item?.avatar;
    }

    async fetchList(page, config) {
        const { bearerToken = null, itemsPerPage = 50, rating = 'explicit' } = config;
        const sort = config.sort || 'dateCreated';
        const order = config.order || 'DESC';

        const url = `${API_BASE}/exploreSearch/characters`;
        const params = { page, limit: itemsPerPage, sort, order, rating };

        try {
            const client = this.createClient(bearerToken);
            const response = await client.get(url, { params });

            return response.data.results || [];
        } catch (error) {
            this.log.error(`Failed to fetch list page ${page}`, error.message);
            throw new Error(`Wyvern list page ${page} failed: ${error.message}`, { cause: error });
        }
    }

    async fetchCard(sourceId) {
        const url = `${API_BASE}/characters/${sourceId}`;

        try {
            const client = this.createClient();
            const response = await client.get(url);
            return { data: response.data, error: null };
        } catch (error) {
            const status = error?.response?.status;
            return { data: null, error: error.message, status };
        }
    }

    async fetchImage(imageUrl) {
        if (!imageUrl) return null;

        // Wyvern uses an image proxy that returns JSON with base64
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
                this.log.warn(`Invalid image proxy response for: ${imageUrl}`);
                return null;
            }

            // Extract base64 part after the comma
            const base64Part = dataUrl.split(',')[1];
            if (!base64Part) {
                this.log.warn(`No base64 data in image proxy response`);
                return null;
            }

            return Buffer.from(base64Part, 'base64');
        } catch (error) {
            this.log.warn(`Failed to fetch image: ${imageUrl}`, error.message);
            return null;
        }
    }

    deriveFeatureFlags(cardData) {
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

        if (!cardData) return flags;

        // Check alternate greetings
        if (Array.isArray(cardData.alternate_greetings) && cardData.alternate_greetings.length > 0) {
            flags.hasAlternateGreetings = true;
        }

        // Check lorebooks
        if (Array.isArray(cardData.lorebooks) && cardData.lorebooks.length > 0) {
            flags.hasLorebook = true;
            flags.hasEmbeddedLorebook = true;
        }

        // Check example dialogues
        if (cardData.mes_example && cardData.mes_example.trim().length > 0) {
            flags.hasExampleDialogues = true;
        }

        // Check system prompt (Wyvern uses pre/post history instructions)
        if ((cardData.pre_history_instructions && cardData.pre_history_instructions.trim().length > 0) ||
            (cardData.post_history_instructions && cardData.post_history_instructions.trim().length > 0)) {
            flags.hasSystemPrompt = true;
        }

        // Check gallery
        if (Array.isArray(cardData.gallery) && cardData.gallery.length > 0) {
            flags.hasGallery = true;
        }

        // Check sprites/expressions
        if (cardData.sprite_set || (Array.isArray(cardData.sprite_sets) && cardData.sprite_sets.length > 0)) {
            flags.hasExpressions = true;
        }

        return flags;
    }

    /**
     * Build CCv2-compatible card definition from Wyvern data
     */
    buildCardDefinition(charData) {
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
                data.character_book = { entries: allEntries };
            }
        }

        return {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data
        };
    }

    /**
     * Estimate token count from character data
     */
    estimateTokenCount(charData) {
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

    async parseCardToMetadata(cardData, dbId, listItem = null) {
        // Derive feature flags
        const flags = this.deriveFeatureFlags(cardData);

        // Estimate token count
        const tokenCount = this.estimateTokenCount(cardData);

        // Build card definition
        const cardDef = this.buildCardDefinition(cardData);

        // Get tags - combine from cardData
        const baseTags = Array.isArray(cardData.tags) ? cardData.tags : [];

        // Infer additional tags
        const cardForTagging = {
            name: cardData.name,
            description: cardData.description || '',
            tagline: cardData.description?.substring(0, 200) || '',
            personality: cardData.personality || '',
            scenario: cardData.scenario || '',
            topics: baseTags,
            definition: cardDef
        };
        const inferredTags = inferTags(cardForTagging);
        // Always add 'wyvern' tag for filtering/sorting
        const allTags = [...new Set(['wyvern', ...baseTags, ...inferredTags])];

        // Map Wyvern stats to our DB fields
        const stats = cardData.statistics_record || cardData.entity_statistics || {};

        return {
            id: dbId,
            name: cardData.name || 'Unknown',
            tagline: cardData.description?.substring(0, 200) || '',
            description: cardData.description || '',
            author: cardData.creator?.displayName || cardData.creator?.uid || 'Anonymous',
            topics: allTags,
            nTokens: tokenCount,
            tokenCount: tokenCount,
            // Map Wyvern stats to Chub-like fields
            starCount: stats.likes || 0,
            n_favorites: stats.follows || 0,
            nChats: stats.views || 0,
            nMessages: stats.messages || 0,
            rating: cardData.rating === 'explicit' ? 1 : cardData.rating === 'suggestive' ? 0.5 : 0,
            createdAt: cardData.created_at || new Date().toISOString(),
            lastModified: cardData.updated_at || cardData.created_at || new Date().toISOString(),
            lastActivityAt: cardData.updated_at || cardData.created_at || new Date().toISOString(),
            fullPath: `wyvern/${cardData.creator?.displayName || 'anonymous'}/${cardData.name || cardData.id}`,
            source: 'wyvern',
            sourceId: cardData.id || cardData._id,
            sourcePath: `characters/${cardData.id || cardData._id}`,
            sourceUrl: `${APP_BASE}/characters/${cardData.id || cardData._id}`,
            visibility: cardData.visibility || 'public',
            ...flags,
            definition: cardDef
        };
    }
}

// Export singleton instance for backwards compatibility
export const wyvernScraper = new WyvernScraper();

// Export sync function for backwards compatibility
export async function syncWyvern(config, progressCallback = null) {
    const scraper = new WyvernScraper();
    const scraperConfig = {
        ...config.wyvernSync,
        pageLimit: config.wyvernSync?.pageLimit || 10,
        itemsPerPage: config.wyvernSync?.itemsPerPage || 50,
        bearerToken: config.wyvernSync?.bearerToken || null,
        rating: config.wyvernSync?.rating || 'explicit'
    };

    if (!config.wyvernSync?.enabled) {
        scraper.log.info('Wyvern sync disabled');
        return { success: true, newCards: 0, updatedCards: 0 };
    }

    return scraper.sync(scraperConfig, progressCallback);
}

// Export refresh function for backwards compatibility
export async function refreshWyvernCard(dbId, config = {}) {
    const scraper = new WyvernScraper();
    return scraper.refreshCard(dbId, config);
}

export default WyvernScraper;
