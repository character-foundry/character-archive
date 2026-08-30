
import axios from 'axios';
import { loadConfig } from '../../config-loader.js';

class SillyTavernService {
    constructor() {
        this.cache = { fetchedAt: 0, ids: [] };
        this.TTL_MS = 30000;
    }

    resetCache() {
        this.cache = { fetchedAt: 0, ids: [] };
    }

    buildSillyTavernHeaders(settings, overrides = {}) {
        const baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
        const headers = {
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            Connection: 'keep-alive',
            Origin: settings.origin || baseUrl,
            Referer: settings.referer || baseUrl
        };

        if (settings.extraHeaders && typeof settings.extraHeaders === 'object') {
            for (const [key, value] of Object.entries(settings.extraHeaders)) {
                if (typeof value === 'string' && value.trim().length > 0) {
                    headers[key] = value;
                }
            }
        }

        return { ...headers, ...overrides };
    }

    extractCardIdFromValue(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const str = String(value).trim();
        if (!str) return null;
        if (/^\d+$/.test(str)) {
            return str;
        }
        const match = str.match(/(\d{3,})/);
        return match ? match[1] : null;
    }

    async fetchSillyPluginCardIds(settings, cookieHeader) {
        const baseUrl = settings.baseUrl.replace(/\/$/, '');
        const headers = this.buildSillyTavernHeaders(settings, {
            Cookie: cookieHeader,
            Accept: 'application/json, text/plain, */*'
        });

        const collected = new Set();
        const maxPages = 20;
        let page = 1;
        let totalCount = null;

        while (page <= maxPages) {
            const targetUrl = `${baseUrl}/api/plugins/my-list-cards/list?page=${page}`;
            const response = await axios.get(targetUrl, {
                headers,
                timeout: 20000,
                validateStatus: () => true
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(response.data?.error || `Silly Tavern returned status ${response.status}`);
            }

            const payload = response.data || {};
            if (typeof payload.count === 'number') {
                totalCount = payload.count;
            }

            const items = Array.isArray(payload.items) ? payload.items : [];
            items.forEach(item => {
                const candidates = [
                    item?.chub_id,
                    item?.chubId,
                    item?.id,
                    item?.chub_full_path,
                    item?.file,
                    item?.card_name,
                    item?.file_name
                ];
                for (const candidate of candidates) {
                    const extracted = this.extractCardIdFromValue(candidate);
                    if (extracted) {
                        collected.add(String(extracted));
                        break;
                    }
                }
            });

            if (items.length === 0) {
                break;
            }

            if (totalCount !== null && collected.size >= totalCount) {
                break;
            }

            page += 1;
        }

        return Array.from(collected);
    }

    async fetchLoadedIds({ forceRefresh = false, cookieHeader = null } = {}) {
        const config = loadConfig();
        const settings = config.sillyTavern || {};
        if (!settings.enabled || !settings.baseUrl) {
            this.resetCache();
            return null;
        }

        const now = Date.now();
        if (!forceRefresh && this.cache.ids.length > 0 && (now - this.cache.fetchedAt) < this.TTL_MS) {
            return new Set(this.cache.ids);
        }

        try {
            const combinedCookie = cookieHeader || settings.sessionCookie || '';
            const ids = await this.fetchSillyPluginCardIds(settings, combinedCookie);
            this.cache = {
                fetchedAt: now,
                ids
            };
            return new Set(ids);
        } catch (error) {
            throw new Error(error?.message || 'Failed to fetch Silly Tavern loaded cards');
        }
    }
}

export const sillyTavernService = new SillyTavernService();
