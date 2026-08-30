/**
 * CtScraper - Scraper for Character Tavern
 *
 * Extends BaseScraper with CT-specific:
 * - REST API at /api/search/cards
 * - Authentication via Cloudflare cookies (cf_clearance)
 * - Direct PNG download from cards.character-tavern.com
 * - Sort options: newest, trending, oldest
 */

import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseScraper } from './BaseScraper.js';
import { detectLanguage, getDatabase } from '../../database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEARCH_URL = 'https://character-tavern.com/api/search/cards';
const CARDS_BASE_URL = 'https://ct-cards.storage.character-tavern.com';
const CT_SITE_URL = 'https://character-tavern.com';

const DEFAULT_HEADERS = {
    accept: '*/*',
    dnt: '1',
    referer: `${CT_SITE_URL}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
};

export class CtScraper extends BaseScraper {
    constructor({
        httpClient = axios,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        imageRetryDelays = [1000, 3000, 7000, 15000, 30000]
    } = {}) {
        super({
            source: 'ct',
            displayName: 'Character Tavern'
        });
        this.http = httpClient;
        this.sleep = sleep;
        this.imageRetryDelays = imageRetryDelays;

        // CT uses database blacklist file in data/
        this.blacklistFile = path.join(__dirname, '../../../data/ct-blacklist.txt');
    }

    // ==================== Helper Methods ====================

    normalizeEpoch(value) {
        if (typeof value === 'number') {
            return value < 1e12 ? value * 1000 : value;
        }
        if (typeof value === 'string') {
            const num = Number(value);
            if (!Number.isNaN(num)) {
                return num < 1e12 ? num * 1000 : num;
            }
        }
        return value;
    }

    toSqlTimestamp(value) {
        if (!value || value === 0 || value === '0') {
            return new Date().toISOString().replace('T', ' ').split('.')[0];
        }
        const normalized = this.normalizeEpoch(value);
        const date = typeof normalized === 'number' ? new Date(normalized) : new Date(normalized);
        if (Number.isNaN(date.getTime())) {
            return new Date().toISOString().replace('T', ' ').split('.')[0];
        }
        return date.toISOString().replace('T', ' ').split('.')[0];
    }

    collapseExamples(examples) {
        if (!examples) return '';
        if (typeof examples === 'string') return examples;
        if (Array.isArray(examples)) {
            return examples
                .map(entry => {
                    if (typeof entry === 'string') return entry;
                    if (entry && typeof entry === 'object') {
                        const text = entry.example || entry.text || entry.message;
                        if (text) return text;
                        try { return JSON.stringify(entry); } catch { return ''; }
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        if (typeof examples === 'object') {
            try { return JSON.stringify(examples); } catch { return ''; }
        }
        return '';
    }

    sanitizeTags(tags) {
        if (!Array.isArray(tags)) return [];
        return Array.from(new Set(tags.map(tag => (tag || '').toString().trim()).filter(Boolean)));
    }

    normalizeSourcePath(value = '') {
        const [author = '', ...slugParts] = String(value || '').trim().replace(/^\/+|\/+$/g, '').split('/');
        const normalizePart = part => part.trim().toLowerCase().replace(/\s+/g, '_');
        return [normalizePart(author), normalizePart(slugParts.join('/'))].filter(Boolean).join('/');
    }

    matchesBannedTags(hit, bannedLower) {
        if (!bannedLower.length) return false;
        const tagSet = new Set((hit.tags || []).map(tag => tag.toLowerCase()));
        return bannedLower.some(tag => tagSet.has(tag));
    }

    formatDescription(hit) {
        return hit.characterDefinition || hit.pageDescription || hit.characterScenario || '';
    }

    buildCookies(config) {
        const cookies = [];
        if (config.cfClearance) {
            cookies.push(`cf_clearance=${config.cfClearance.trim()}`);
        }
        if (config.session) {
            cookies.push(`session=${config.session.trim()}`);
        }
        if (config.allowedWarnings) {
            cookies.push(`content_warnings=${config.allowedWarnings.trim()}`);
        }
        return cookies;
    }

    // ==================== Abstract Method Implementations ====================

    getSourceId(item) {
        return item.id;
    }

    getRemoteTimestamp(item) {
        return item.lastUpdateAt || item.updatedAt || item.updated_at || item.createdAt || item.created_at;
    }

    getImageRef(item) {
        return item.path;
    }

    /**
     * Fetch paginated list from CT's search API
     */
    async fetchList(page, config) {
        const {
            hitsPerPage = 30,
            bannedTags = [],
            cookies = [],
            sort = 'newest',
            query = ''
        } = config;

        // Build query params
        const params = new URLSearchParams();
        params.set('limit', String(hitsPerPage));
        params.set('page', String(page));
        params.set('sort', sort);
        if (query) {
            params.set('query', query);
        }

        const url = `${SEARCH_URL}?${params.toString()}`;

        const headers = { ...DEFAULT_HEADERS };

        if (cookies.length > 0) {
            headers.Cookie = cookies.join('; ');
        }

        try {
            const response = await this.http.get(url, {
                headers,
                timeout: 30000
            });

            const hits = response.data?.hits || [];

            // Store banned tags filter for processCard
            this._bannedTagsLower = (bannedTags || []).map(t => t.toLowerCase());
            this._totalPages = response.data?.totalPages || null;

            return hits;
        } catch (error) {
            if (error?.response?.status === 403) {
                throw new Error('Character Tavern search returned 403 (check Cloudflare cookie)');
            }
            throw error;
        }
    }

    /**
     * CT doesn't need separate card fetch - data comes from list
     */
    async fetchCardBundle(item, config = {}) {
        const sourcePath = this.normalizeSourcePath(item?.path);
        if (!sourcePath || !sourcePath.includes('/')) {
            throw new Error(`Character Tavern card ${item?.id || 'unknown'} has no valid author/slug path`);
        }
        const headers = { ...DEFAULT_HEADERS };
        const cookies = config.cookies || this._currentCookies || [];
        if (cookies.length) headers.Cookie = cookies.join('; ');

        const detailResponse = await this.http.get(`${CT_SITE_URL}/api/character/${sourcePath}`, {
            headers,
            timeout: 30000
        });
        const card = detailResponse.data?.card;
        if (!card?.id) throw new Error(`Character Tavern detail response for ${sourcePath} contained no card`);

        const metadataUrl = suffix => `${CT_SITE_URL}/api/character/${encodeURIComponent(card.id)}/${suffix}`;
        const [tagsResponse, greetingsResponse, warningsResponse, lorebookResponse] = await Promise.all([
            this.http.get(metadataUrl('tags'), { headers, timeout: 30000 }),
            this.http.get(metadataUrl('alternative-greetings'), { headers, timeout: 30000 }),
            this.http.get(metadataUrl('content-warnings'), { headers, timeout: 30000 }),
            card.lorebookId
                ? this.http.get(metadataUrl('lorebook'), { headers, timeout: 30000 })
                : Promise.resolve({ data: null })
        ]);

        if (!Array.isArray(tagsResponse.data)) throw new Error(`Character Tavern tags for ${card.id} were malformed`);
        if (!Array.isArray(greetingsResponse.data)) throw new Error(`Character Tavern greetings for ${card.id} were malformed`);
        if (!Array.isArray(warningsResponse.data?.contentWarnings)) {
            throw new Error(`Character Tavern warnings for ${card.id} were malformed`);
        }
        if (card.lorebookId && !lorebookResponse.data?.id) {
            throw new Error(`Character Tavern lorebook ${card.lorebookId} for ${card.id} was missing`);
        }

        return {
            listItem: item,
            card: { ...card, path: sourcePath },
            tags: this.sanitizeTags(tagsResponse.data),
            alternateGreetings: greetingsResponse.data.filter(value => typeof value === 'string' && value.trim()),
            contentWarnings: warningsResponse.data.contentWarnings,
            lorebook: lorebookResponse.data || null
        };
    }

    async fetchCard(_sourceId) {
        return { data: null, error: 'Character Tavern cards are fetched by author/slug path' };
    }

    /**
     * Download card PNG from CT CDN
     */
    async fetchImage(cardPath) {
        if (!cardPath) return null;

        const normalizedPath = this.normalizeSourcePath(cardPath);
        const url = `${CARDS_BASE_URL}/${normalizedPath}.png`;
        const headers = {
            accept: 'image/png',
            referer: `${CT_SITE_URL}/`,
            'user-agent': DEFAULT_HEADERS['user-agent']
        };

        // Add cookies if we have them stored
        if (this._currentCookies && this._currentCookies.length > 0) {
            headers.Cookie = this._currentCookies.join('; ');
        }

        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        let lastError;

        for (let attempt = 0; attempt <= this.imageRetryDelays.length; attempt += 1) {
            try {
                const response = await this.http.get(url, {
                    responseType: 'arraybuffer',
                    headers,
                    timeout: 30000
                });
                const buffer = Buffer.from(response.data);
                if (buffer.length < signature.length || !buffer.subarray(0, signature.length).equals(signature)) {
                    const contentType = response.headers?.['content-type'] || response.headers?.get?.('content-type') || 'unknown';
                    throw new Error(`Character Tavern image for ${normalizedPath} is not a valid PNG (content-type: ${contentType})`);
                }
                return buffer;
            } catch (error) {
                lastError = error;
                const status = Number(error?.response?.status || 0);
                const retryable = status === 404
                    || status === 409
                    || status === 425
                    || status === 429
                    || (status >= 500 && status <= 599);
                const delay = this.imageRetryDelays[attempt];
                if (!retryable || delay === undefined) break;
                this.log.warn(`Character Tavern image for ${normalizedPath} is not ready; retrying in ${delay}ms`);
                await this.sleep(delay);
            }
        }

        throw new Error(`Failed to download Character Tavern image for ${normalizedPath}: ${lastError.message}`, { cause: lastError });
    }

    deriveFeatureFlags(bundle) {
        const hit = bundle?.card || bundle || {};
        return {
            hasAlternateGreetings: Array.isArray(bundle?.alternateGreetings) && bundle.alternateGreetings.length > 0,
            hasExampleDialogues: Boolean(hit.definition_example_messages?.trim()),
            hasSystemPrompt: Boolean(hit.definition_system_prompt?.trim() || hit.definition_post_history_prompt?.trim()),
            hasLorebook: Boolean(bundle?.lorebook?.entries?.length),
            hasEmbeddedLorebook: Boolean(bundle?.lorebook?.entries?.length),
            hasLinkedLorebook: Boolean(hit.lorebookId),
            hasGallery: false,
            hasEmbeddedImages: false,
            hasExpressions: false
        };
    }

    async parseCardToMetadata(bundle, dbId) {
        const hit = bundle?.card || bundle;
        const description = hit.definition_character_description || hit.description || '';
        const tags = this.sanitizeTags(bundle?.tags || []);
        const language = detectLanguage(description || hit.tagline || hit.definition_first_message || '');
        const flags = this.deriveFeatureFlags(bundle);

        const createdAtRaw = hit.createdAt || hit.created_at;
        const lastUpdateAtRaw = hit.lastUpdatedAt || hit.lastUpdateAt || hit.updatedAt || hit.updated_at;
        const createdAtSql = this.toSqlTimestamp(createdAtRaw);
        const lastUpdateSql = this.toSqlTimestamp(
            (lastUpdateAtRaw === 0 || lastUpdateAtRaw === '0') ? createdAtRaw : (lastUpdateAtRaw || createdAtRaw)
        );

        const ctPath = this.normalizeSourcePath(hit.path);
        const sourceUrl = `${CT_SITE_URL}/character/${ctPath || hit.id}`;
        const lorebookEntries = Array.isArray(bundle?.lorebook?.entries)
            ? bundle.lorebook.entries.map(entry => ({
                name: entry.name || '',
                content: entry.content || '',
                enabled: entry.enabled !== false,
                insertion_order: Number(entry.insertionOrder || 0),
                constant: Boolean(entry.constant),
                keys: Array.isArray(entry.keys) ? entry.keys : []
            }))
            : [];
        const definitionData = {
            name: hit.inChatName || hit.name || 'Untitled',
            description,
            personality: hit.definition_personality || '',
            scenario: hit.definition_scenario || '',
            first_mes: hit.definition_first_message || '',
            mes_example: hit.definition_example_messages || '',
            alternate_greetings: bundle?.alternateGreetings || [],
            system_prompt: hit.definition_system_prompt || '',
            post_history_instructions: hit.definition_post_history_prompt || '',
            tags,
            creator: ctPath.split('/')[0] || '',
            creator_notes: hit.description || '',
            character_version: String(hit.versionId ?? ''),
            extensions: {
                character_tavern: {
                    id: hit.id,
                    versionId: hit.versionId ?? null,
                    contentWarnings: bundle?.contentWarnings || [],
                    lorebookId: hit.lorebookId ?? null
                }
            }
        };
        if (lorebookEntries.length) {
            definitionData.character_book = {
                name: bundle.lorebook.name || '',
                description: bundle.lorebook.description || '',
                scan_depth: bundle.lorebook.scanDepth ?? null,
                entries: lorebookEntries
            };
        }
        const definition = { spec: 'chara_card_v2', spec_version: '2.0', data: definitionData };

        return {
            id: dbId,
            author: ctPath.split('/')[0] || String(hit.author || ''),
            name: hit.name || hit.inChatName || 'Untitled',
            tagline: hit.tagline || '',
            description,
            topics: tags,
            nTokens: hit.tokenTotal || hit.totalTokens || 0,
            tokenCount: hit.tokenTotal || hit.totalTokens || 0,
            tokenDescriptionCount: hit.tokenDescription ?? null,
            tokenPersonalityCount: hit.tokenPersonality ?? null,
            tokenScenarioCount: hit.tokenScenario ?? null,
            tokenMesExampleCount: hit.tokenMesExample ?? null,
            tokenFirstMessageCount: hit.tokenFirstMes ?? null,
            tokenSystemPromptCount: hit.tokenSystemPrompt ?? null,
            tokenPostHistoryCount: hit.tokenPostHistoryInstructions ?? null,
            lastModified: lastUpdateSql,
            lastActivityAt: lastUpdateSql,
            createdAt: createdAtSql,
            nChats: 0,
            nMessages: hit.analytics_messages || bundle?.listItem?.messages || 0,
            n_favorites: bundle?.listItem?.likes || 0,
            starCount: hit.analytics_downloads || bundle?.listItem?.downloads || 0,
            ratingsEnabled: 0,
            rating: 0,
            ratingCount: 0,
            fullPath: hit.path || '',
            favorited: 0,
            language,
            visibility: 'public',
            ...flags,
            source: 'ct',
            sourceId: hit.id,
            sourcePath: ctPath,
            sourceUrl,
            sourceVersionId: hit.versionId ?? null,
            contentWarnings: bundle?.contentWarnings || [],
            alternate_greetings: bundle?.alternateGreetings || [],
            mes_example: hit.definition_example_messages || '',
            system_prompt: hit.definition_system_prompt || '',
            post_history_instructions: hit.definition_post_history_prompt || '',
            character_book: definitionData.character_book || null,
            definition,
            rawHit: bundle?.listItem || null,
            remoteCard: hit
        };
    }

    /**
     * Override processCard to handle CT-specific filtering
     */
    async processCard(item, config = {}) {
        const sourceId = this.getSourceId(item);

        // Check blacklist
        if (this.isBlacklisted(sourceId)) {
            return { success: false, reason: 'blacklisted' };
        }

        try {
            const bundle = await this.fetchCardBundle(item, config);
            if (this._bannedTagsLower && this.matchesBannedTags({ tags: bundle.tags }, this._bannedTagsLower)) {
                return { success: false, reason: 'banned_tags' };
            }
            const excludedWarnings = new Set((config.excludedWarnings || []).map(value => String(value).toLowerCase()));
            if (bundle.contentWarnings.some(value => excludedWarnings.has(String(value).toLowerCase()))) {
                return { success: false, reason: 'excluded_warning' };
            }
            const totalTokens = Number(bundle.card.tokenTotal || bundle.card.totalTokens || 0);
            if (totalTokens < (config.minTokens || 0)) return { success: false, reason: 'below_min_tokens' };
            if (config.maxTokens && totalTokens > config.maxTokens) return { success: false, reason: 'above_max_tokens' };

            const sourcePath = this.normalizeSourcePath(bundle.card.path);
            const existing = getDatabase().prepare(`
                SELECT id, lastModified, sourceId, sourcePath
                FROM cards
                WHERE source = 'ct' AND (sourceId = ? OR LOWER(sourcePath) = ?)
                ORDER BY id ASC
                LIMIT 1
            `).get(String(bundle.card.id), sourcePath);
            const remoteTimestamp = new Date(bundle.card.lastUpdatedAt || bundle.card.createdAt || 0).getTime();
            const localTimestamp = existing?.lastModified ? new Date(existing.lastModified).getTime() : 0;
            if (existing && !config.force && remoteTimestamp > 0 && remoteTimestamp <= localTimestamp) {
                return { success: false, reason: 'unchanged', dbId: existing.id };
            }

            const dbId = existing?.id || this.getNextDbId();
            const metadata = await this.parseCardToMetadata(bundle, dbId);

            // CT images are required. fetchImage validates the signature and throws on failure.
            const imageBuffer = await this.fetchImage(sourcePath);

            await this.writeCardFiles(dbId, { json: metadata, png: imageBuffer });
            this.upsertCard(metadata);

            this.log.info(`${existing ? 'Updated' : 'Imported'} CT card: ${metadata.name} (${sourceId} -> ${dbId})`);

            return {
                success: true,
                isNew: !existing,
                dbId,
                name: metadata.name
            };
        } catch (error) {
            this.log.error(`Failed to import CT card ${item?.name || item?.path || item?.id}`, error);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Override sync to handle CT-specific configuration
     */
    async sync(config = {}, progressCallback = null) {
        const pageLimit = config.pages || config.pageLimit || 1;

        const cookies = this.buildCookies({
            cfClearance: config.cfClearance || process.env.CT_CF_CLEARANCE,
            session: config.session || process.env.CT_SESSION,
            allowedWarnings: config.allowedWarnings || process.env.CT_ALLOWED_WARNINGS
        });

        // Store cookies for image download
        this._currentCookies = cookies;

        const scraperConfig = {
            cookies,
            hitsPerPage: Math.min(config.hitsPerPage || 30, 50),
            minTokens: config.minTokens || 300,
            maxTokens: config.maxTokens || 900000,
            bannedTags: config.bannedTags || [],
            excludedWarnings: config.excludedWarnings || [],
            sort: config.sort || 'newest',
            query: config.query || '',
            force: Boolean(config.force || config.forceUpdate),
            fullReconcile: Boolean(config.fullReconcile)
        };

        this.log.info(`Starting CT sync (${pageLimit} pages)...`);
        this.loadBlacklist();

        let added = 0;
        let updated = 0;
        let skipped = 0;
        let errors = 0;
        let processed = 0;

        for (let page = 1; config.fullReconcile || page <= pageLimit; page++) {
            let hits;
            try {
                hits = await this.fetchList(page, scraperConfig);
            } catch (error) {
                this.log.error(`Failed to fetch CT page ${page}`, error.message);
                throw error;
            }

            if (!hits || hits.length === 0) {
                this.log.info(`No more results on page ${page}`);
                break;
            }

            for (const hit of hits) {
                processed++;
                const result = await this.processCard(hit, scraperConfig);

                if (result.success) {
                    if (result.isNew) added++;
                    else updated++;
                    this.reportProgress(progressCallback, {
                        progress: Math.round((page / pageLimit) * 100),
                        currentCard: `[CT] ${result.name}`,
                        newCards: added,
                        page,
                        processed,
                        added,
                        skipped
                    });
                } else {
                    skipped++;
                    if (result.reason === 'error' || result.reason === 'fetch_failed') errors++;
                }
            }

            // Check if we've reached the end
            if (this._totalPages && page >= this._totalPages) {
                break;
            }
        }

        this.log.info(`CT sync complete: ${added} added, ${updated} updated, ${skipped} skipped, ${errors} errors, ${processed} processed`);

        return { success: errors === 0 || added + updated > 0, newCards: added, updatedCards: updated, added, updated, skipped, errors, processed };
    }
}

// Export singleton instance for backwards compatibility
export const ctScraper = new CtScraper();

// Export sync function for backwards compatibility
export async function syncCharacterTavern(appConfig = {}, progressCallback = null) {
    const scraper = new CtScraper();
    const ctConfig = appConfig.ctSync || {};

    if (!ctConfig.enabled) {
        return { added: 0, skipped: 0, processed: 0 };
    }

    return scraper.sync(ctConfig, progressCallback);
}

export default CtScraper;
