/**
 * RisuAiScraper - Scraper for RisuAI characters
 *
 * Extends BaseScraper with RisuAI-specific:
 * - Multiple download formats (CharX, PNG, JSON-v3, JSON-v2)
 * - HTML parsing for card metadata
 * - PNG embedding for character data
 * - Complex date parsing (RisuAI epoch format)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { load as cheerioLoad } from 'cheerio';
import { readCardJsonOnly, readCharX } from '@character-foundry/charx';
import { parseCard } from '@character-foundry/loader';
import { BaseScraper } from './BaseScraper.js';
import { inferTags } from '../../utils/keyword-tagger.js';
import { rateLimitedRequest } from '../ApiClient.js';

const BASE_URL = 'https://realm.risuai.net';
const RESOURCE_URL = 'https://sv.risuai.xyz/resource';

export class RisuAiScraper extends BaseScraper {
    constructor() {
        super({
            source: 'risuai',
            displayName: 'RisuAI'
        });
    }

    // ==================== Helper Methods ====================

    /**
     * Parse RisuAI epoch timestamp
     * Their dates are weird - roughly (unix_ms / 100000)
     */
    parseRisuDate(dateVal) {
        if (!dateVal) return new Date().toISOString();

        const num = Number(dateVal);
        if (isNaN(num)) return new Date().toISOString();

        try {
            const ms = num * 100000;
            const d = new Date(ms);
            if (d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
                return d.toISOString();
            }
        } catch (e) {
            // Fall through
        }

        return new Date().toISOString();
    }

    parseDownloadCount(val) {
        if (typeof val === 'number') return val;
        if (!val) return 0;
        const str = String(val).toLowerCase();
        if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
        if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000000);
        return Math.round(parseFloat(str)) || 0;
    }

    detectImageFormat(buffer) {
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
     * Parse card data from RisuAI HTML page
     */
    parseRisuHtml(html) {
        const $ = cheerioLoad(html);
        const scripts = $('script');
        let cardData = null;
        let isCharX = false;

        scripts.each((i, el) => {
            const text = $(el).html();
            if (text && text.includes('data: [')) {
                try {
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
                    this.log.warn('Failed to parse RisuAI data array', e.message);
                }

                if (text.includes('/api/v1/download/charx-v3/')) {
                    isCharX = true;
                }
            }
        });

        return { cardData, isCharX };
    }

    /**
     * Extract JSON from CharX file
     */
    extractFromCharX(charxBuffer) {
        try {
            const result = readCharX(new Uint8Array(charxBuffer), {
                maxTotalSize: 500 * 1024 * 1024 // 500MB
            });
            return {
                card: result.card,
                assetCount: result.assets?.length || 0,
                isRisuFormat: result.isRisuFormat
            };
        } catch (error) {
            this.log.error('Failed to extract from CharX', error);
            return null;
        }
    }

    extractJsonFromCharX(charxBuffer) {
        try {
            return readCardJsonOnly(new Uint8Array(charxBuffer));
        } catch (error) {
            this.log.error('Failed to extract JSON from CharX', error);
            return null;
        }
    }

    // ==================== Abstract Method Implementations ====================

    getSourceId(item) {
        return item.id;
    }

    getRemoteTimestamp(item) {
        return this.parseRisuDate(item.date);
    }

    getImageRef(item, cardData) {
        return item.img;
    }

    async fetchList(page, config) {
        const url = `${BASE_URL}/?sort=latest&page=${page}`;
        try {
            const response = await rateLimitedRequest(url);
            const $ = cheerioLoad(response.data);

            const cards = [];
            $('a[href^="/character/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href) {
                    cards.push({ url: href });
                }
            });

            return cards;
        } catch (error) {
            this.log.error(`Failed to fetch list page ${page}`, error);
            throw new Error(`RisuAI list page ${page} failed: ${error.message}`, { cause: error });
        }
    }

    /**
     * Fetch and parse a single card page to get node data
     */
    async fetchNode(cardUrl) {
        const fullUrl = `${BASE_URL}/${cardUrl.replace(/^\//, '')}`;

        try {
            const response = await rateLimitedRequest(fullUrl);
            const { cardData, isCharX } = this.parseRisuHtml(response.data);

            if (!cardData || !cardData.id) {
                this.log.warn(`No valid card data found for ${cardUrl}`);
                return null;
            }

            return {
                ...cardData,
                is_charx: isCharX,
                authorname: cardData.authorname || 'Anonymous',
                tags: Array.isArray(cardData.tags) ? cardData.tags : []
            };
        } catch (error) {
            this.log.error(`Failed to fetch node ${cardUrl}`, error);
            return null;
        }
    }

    async fetchCard(sourceId) {
        // For RisuAI, we need to fetch the node first
        const node = await this.fetchNode(`/character/${sourceId}`);
        if (!node) {
            return { data: null, error: 'Failed to fetch node' };
        }

        // Try download formats in priority order: CharX → PNG → JSON-v3 → JSON-v2
        let cardDef = null;
        let assetCount = 0;
        let fullPngBuffer = null;
        let charxBuffer = null;

        // 1. Try CharX first (best format)
        try {
            const charxUrl = `${BASE_URL}/api/v1/download/charx-v3/${sourceId}?non_commercial=true`;
            const response = await rateLimitedRequest(charxUrl, {
                responseType: 'arraybuffer',
                timeout: 120000
            });

            charxBuffer = Buffer.from(response.data);
            const charxData = this.extractFromCharX(charxBuffer);
            if (charxData && charxData.card) {
                cardDef = charxData.card;
                assetCount = charxData.assetCount;
                this.log.info(`CharX OK for ${sourceId} (${assetCount} assets)`);
            }
        } catch (error) {
            this.log.debug(`CharX failed for ${sourceId}: ${error.message}`);
        }

        // 2. Try PNG if CharX failed
        if (!cardDef) {
            try {
                const pngUrl = `${BASE_URL}/api/v1/download/png-v3/${sourceId}?non_commercial=true`;
                const response = await rateLimitedRequest(pngUrl, {
                    responseType: 'arraybuffer',
                    timeout: 120000
                });

                fullPngBuffer = Buffer.from(response.data);
                const parsed = parseCard(fullPngBuffer, `${sourceId}.png`);
                if (parsed && parsed.card) {
                    cardDef = parsed.card;
                    this.log.info(`PNG OK for ${sourceId}`);
                }
            } catch (error) {
                this.log.debug(`PNG failed for ${sourceId}: ${error.message}`);
            }
        }

        // 3. Try JSON-v3
        if (!cardDef) {
            try {
                const jsonUrl = `${BASE_URL}/api/v1/download/json-v3/${sourceId}?non_commercial=true`;
                const response = await rateLimitedRequest(jsonUrl, {
                    responseType: 'json',
                    timeout: 30000
                });
                cardDef = response.data;
                this.log.info(`JSON-v3 OK for ${sourceId}`);
            } catch (error) {
                this.log.debug(`JSON-v3 failed for ${sourceId}: ${error.message}`);
            }
        }

        // 4. Try JSON-v2 as last resort
        if (!cardDef) {
            try {
                const jsonUrl = `${BASE_URL}/api/v1/download/json-v2/${sourceId}?non_commercial=true`;
                const response = await rateLimitedRequest(jsonUrl, {
                    responseType: 'json',
                    timeout: 30000
                });
                cardDef = response.data;
                this.log.info(`JSON-v2 OK for ${sourceId}`);
            } catch (error) {
                this.log.debug(`JSON-v2 failed for ${sourceId}: ${error.message}`);
            }
        }

        if (!cardDef) {
            return { data: null, error: 'All download methods failed' };
        }

        return {
            data: {
                ...node,
                cardDef,
                assetCount,
                fullPngBuffer,
                charxBuffer
            },
            error: null
        };
    }

    async fetchImage(imgHash) {
        const url = `${RESOURCE_URL}/${imgHash}`;
        try {
            const response = await rateLimitedRequest(url, {
                responseType: 'arraybuffer',
                timeout: 30000
            });
            return Buffer.from(response.data);
        } catch (error) {
            this.log.warn(`Failed to fetch thumbnail ${imgHash}`, error.message);
            return null;
        }
    }

    deriveFeatureFlags(cardDef) {
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
            this.log.warn('Failed to derive feature flags', error.message);
        }

        return flags;
    }

    /**
     * Estimate token count from card definition
     */
    estimateTokenCount(cardDef) {
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

    async parseCardToMetadata(rawData, dbId, listItem = null) {
        const node = listItem || rawData;
        const cardDef = rawData.cardDef || rawData;
        const cardData = cardDef?.data || cardDef;

        // Derive feature flags
        const flags = this.deriveFeatureFlags(cardDef);

        // Node-level flags
        if (node.hasLore || node.haslore) {
            flags.hasLorebook = true;
            flags.hasEmbeddedLorebook = true;
        }
        if (node.hasEmotion) {
            flags.hasExpressions = true;
        }
        if (node.hasAsset || rawData.assetCount > 0) {
            flags.hasGallery = true;
        }

        // Estimate token count
        const tokenCount = this.estimateTokenCount(cardDef);

        // Parse date
        const nodeDate = this.parseRisuDate(node.date);

        // Build tags
        const baseTags = Array.isArray(node.tags) ? node.tags : [];
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

        return {
            id: dbId,
            name: cardData?.name || node.name || 'Unknown',
            description: cardData?.description || node.desc || '',
            tagline: node.desc?.substring(0, 200) || '',
            author: node.authorname || 'Anonymous',
            topics: allTags,
            nTokens: tokenCount,
            tokenCount: tokenCount,
            starCount: this.parseDownloadCount(node.download),
            n_favorites: 0,
            createdAt: nodeDate,
            lastModified: nodeDate,
            lastActivityAt: nodeDate,
            fullPath: `risuai/${node.authorname || 'anonymous'}/${node.name || node.id}`,
            source: 'risuai',
            sourceId: node.id,
            sourcePath: `character/${node.id}`,
            sourceUrl: `${BASE_URL}/character/${node.id}`,
            visibility: node.hidden ? 'hidden' : 'public',
            ...flags,
            definition: cardDef
        };
    }

    /**
     * Override processCard to handle RisuAI's special file formats
     */
    async processCard(item, config = {}) {
        // For list items, we need to fetch the node first
        if (item.url && !item.id) {
            const node = await this.fetchNode(item.url);
            if (!node) {
                return { success: false, reason: 'node_fetch_failed' };
            }
            item = node;
        }

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

        // Check existing - RisuAI dates are unreliable (often returns download date, not creation date)
        // Skip entirely if we already have this card unless force or forceUpdate is enabled
        // No timestamp comparison - can't trust RisuAI dates for update detection
        const existing = this.checkExisting(sourceId);
        const forceUpdate = config.forceUpdate || false;
        if (existing && !force && !forceUpdate) {
            this.log.debug(`Card ${sourceId} already exists, skipping (no updates for RisuAI)`);
            return { success: false, reason: 'exists', dbId: existing.id };
        }

        const dbId = existing?.id || this.getNextDbId();

        try {
            // Fetch card data with all formats
            const fetchResult = await this.fetchCard(sourceId);
            if (fetchResult.error || !fetchResult.data) {
                this.log.warn(`Failed to fetch card ${sourceId}: ${fetchResult.error}`);
                this.setCooldown(sourceId);
                return { success: false, reason: 'fetch_failed', error: fetchResult.error };
            }

            const cardData = fetchResult.data;

            // Parse to metadata
            const metadata = await this.parseCardToMetadata(cardData, dbId, item);

            // Prepare files to write
            const filesToWrite = { json: metadata };

            // Fetch thumbnail for grid display
            if (item.img) {
                const thumbnailBuffer = await this.fetchImage(item.img);
                if (thumbnailBuffer) {
                    filesToWrite.png = thumbnailBuffer;
                }
            }

            // Write CharX if we have it
            if (cardData.charxBuffer) {
                filesToWrite.charx = cardData.charxBuffer;
            }

            // Write full PNG if we have it
            if (cardData.fullPngBuffer) {
                filesToWrite.fullPng = cardData.fullPngBuffer;
            }

            await this.writeCardFiles(dbId, filesToWrite);

            this.setCooldown(sourceId);
            this.upsertCard(metadata);

            this.log.info(`${existing ? 'Updated' : 'Imported'} card: ${metadata.name} (${sourceId} -> ${dbId})`);

            return {
                success: true,
                isNew: !existing,
                dbId,
                name: metadata.name
            };
        } catch (error) {
            this.log.error(`Error processing card ${sourceId}`, error);
            this.setCooldown(sourceId);
            return { success: false, reason: 'error', error: error.message };
        }
    }
}

// Export singleton instance for backwards compatibility
export const risuAiScraper = new RisuAiScraper();

// Export sync function for backwards compatibility
export async function syncRisuAi(config, progressCallback = null) {
    const scraper = new RisuAiScraper();

    if (!config.risuAiSync?.enabled) {
        scraper.log.info('RisuAI sync disabled');
        return { success: true, newCards: 0, updatedCards: 0 };
    }

    const scraperConfig = {
        pageLimit: config.risuAiSync?.pageLimit || 5,
        ...config.risuAiSync
    };

    return scraper.sync(scraperConfig, progressCallback);
}

// Export refresh function for backwards compatibility
export async function refreshRisuCard(dbId, config = {}) {
    const scraper = new RisuAiScraper();
    return scraper.refreshCard(dbId, config);
}

export default RisuAiScraper;
