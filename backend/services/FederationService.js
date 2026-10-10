/**
 * Federation Service
 *
 * Thin wrapper around @character-foundry/character-foundry/federation package.
 * The package does the work - this just configures it.
 */

import {
    SyncEngine,
    FileSyncStateStore,
    HttpPlatformAdapter,
    createActor,
    enableFederation,
    isFederationEnabled,
} from '@character-foundry/character-foundry/federation';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const baseUrl = process.env.FEDERATION_BASE_URL || 'http://localhost:3100';
const stateDir = process.env.FEDERATION_STATE_DIR || path.join(__dirname, '../../data/federation');

// Lazy-initialized instances (federation requires explicit opt-in)
let _stateStore = null;
let _syncEngine = null;

function getStateStore() {
    if (!_stateStore) {
        _stateStore = new FileSyncStateStore(stateDir);
    }
    return _stateStore;
}

function getSyncEngine() {
    if (!_syncEngine) {
        // Federation v0.2.0+ requires explicit opt-in for security
        if (!isFederationEnabled()) {
            enableFederation();
        }
        _syncEngine = new SyncEngine({
            baseUrl,
            actorId: `${baseUrl}/api/federation/actor`,
            stateStore: getStateStore(),
        });
    }
    return _syncEngine;
}

// Backwards-compatible exports (lazy)
const stateStore = { get: (...args) => getStateStore().get(...args), list: (...args) => getStateStore().list(...args) };
const syncEngine = {
    registerPlatform: (...args) => getSyncEngine().registerPlatform(...args),
    unregisterPlatform: (...args) => getSyncEngine().unregisterPlatform(...args),
    pushCard: (...args) => getSyncEngine().pushCard(...args),
};

// Platform configs (could move to env/db)
const platformConfigs = {
    sillytavern: {
        baseUrl: process.env.ST_BASE_URL || null,
        apiKey: process.env.ST_API_KEY || null,
        endpoints: {
            actor: '/api/plugins/cforge/federation/actor',
            inbox: '/api/plugins/cforge/federation/inbox',
            outbox: '/api/plugins/cforge/federation/outbox',
            assets: '/api/plugins/cforge/federation/assets',
        },
    },
    architect: {
        baseUrl: process.env.ARCHITECT_BASE_URL || null,
        apiKey: process.env.ARCHITECT_API_KEY || null,
        endpoints: {
            actor: '/api/federation/actor',
            inbox: '/api/federation/inbox',
            outbox: '/api/federation/outbox',
            assets: '/api/federation/assets',
        },
    },
};

/**
 * Get actor for this archive
 */
export function getActor() {
    return createActor({
        id: `${baseUrl}/api/federation/actor`,
        username: 'character-archive',
        displayName: 'Character Archive',
        baseUrl,
    });
}

/**
 * Get adapter for a remote platform
 */
export function getRemoteAdapter(platform) {
    const config = platformConfigs[platform];
    if (!config?.baseUrl) return null;

    return new HttpPlatformAdapter({
        platform,
        displayName: platform,
        baseUrl: config.baseUrl,
        endpoints: {
            list: config.endpoints.outbox,
            get: config.endpoints.assets,
            create: config.endpoints.inbox,
            update: config.endpoints.inbox,
            delete: config.endpoints.inbox,
            health: config.endpoints.actor,
        },
        auth: config.apiKey ? { type: 'bearer', token: config.apiKey } : undefined,
    });
}

/**
 * Push card to platform - delegates to SyncEngine
 */
export async function pushCard(localAdapter, cardId, targetPlatform) {
    const remoteAdapter = getRemoteAdapter(targetPlatform);
    if (!remoteAdapter) {
        throw new Error(`Platform not configured: ${targetPlatform}`);
    }

    syncEngine.registerPlatform(localAdapter);
    syncEngine.registerPlatform(remoteAdapter);

    try {
        return await syncEngine.pushCard(localAdapter.platform, cardId, targetPlatform);
    } finally {
        syncEngine.unregisterPlatform(targetPlatform);
    }
}

/**
 * Get sync state - delegates to state store
 */
export async function getSyncState(federatedId) {
    return stateStore.get(federatedId);
}

/**
 * List all sync states
 */
export async function listSyncStates() {
    return stateStore.list();
}

/**
 * Get Set of card names that exist on a remote platform
 * Queries the platform's federation outbox directly
 */
export async function getRemoteCardNames(platform) {
    // Get config from database, not env vars
    const { getDatabase } = await import('../database.js');
    const db = getDatabase();
    const config = db.prepare('SELECT * FROM federation_platforms WHERE platform = ?').get(platform);

    if (!config?.base_url || !config.enabled) return new Set();

    try {
        // Use standard federation endpoints
        const outboxPath = platform === 'sillytavern'
            ? '/api/plugins/cforge/federation/outbox'
            : '/api/federation/outbox';

        const outboxUrl = `${config.base_url}${outboxPath}?limit=1000`;
        const response = await fetch(outboxUrl, {
            headers: config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {},
        });

        if (!response.ok) return new Set();

        const data = await response.json();
        const names = new Set();

        // Handle both array and OrderedCollection formats
        const items = Array.isArray(data) ? data : (data.items || []);
        for (const item of items) {
            if (item.name) names.add(item.name.toLowerCase());
        }

        return names;
    } catch (error) {
        console.warn(`Failed to fetch ${platform} outbox:`, error.message);
        return new Set();
    }
}

/**
 * Record sync to SQLite
 */
async function recordSync(cardId, platform, remoteId) {
    try {
        const { getDatabase } = await import('../database.js');
        const db = getDatabase();
        db.prepare(`
            INSERT INTO federation_sync (card_id, platform, platform_id, status, last_sync_at)
            VALUES (?, ?, ?, 'synced', CURRENT_TIMESTAMP)
            ON CONFLICT(card_id, platform) DO UPDATE SET
                platform_id = excluded.platform_id,
                status = 'synced',
                last_sync_at = CURRENT_TIMESTAMP
        `).run(cardId, platform, remoteId || null);
    } catch (error) {
        console.warn('Failed to record sync:', error.message);
    }
}

// Legacy API expected by CardController
export const federationService = {
    getPlatformConfig(platform) {
        const config = platformConfigs[platform];
        return config?.baseUrl ? { ...config, enabled: true } : null;
    },
    async pushToSillyTavern(cardId, overwrite) {
        const { archiveAdapter } = await import('./ArchiveAdapter.js');
        const result = await pushCard(archiveAdapter, cardId, 'sillytavern');
        if (result?.success) {
            await recordSync(cardId, 'sillytavern', result.remoteId || result.filename);
        }
        return result;
    },
    async pushToArchitect(cardId) {
        const { archiveAdapter } = await import('./ArchiveAdapter.js');
        const result = await pushCard(archiveAdapter, cardId, 'architect');
        if (result?.success) {
            await recordSync(cardId, 'architect', result.remoteId);
        }
        return result;
    },
};

export { syncEngine, stateStore, baseUrl };
