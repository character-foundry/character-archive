import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { compareFavoriteStates, isFavoriteState, instanceApiUrl } from '@character-foundry/character-foundry/integrations';
import { getDatabase } from '../database.js';
import { setCardFavoriteFlag } from './CardService.js';
import { appConfig } from './ConfigState.js';
import { invalidateCache } from './CardQueryService.js';
import { logger } from '../utils/logger.js';
import { uploadCardPng } from './DirectCardUpload.js';

const log = logger.scoped('FAVORITES');
let running = null;
const initializedDatabases = new WeakSet();
const uploads = new Map();

export function ensureFavoriteTables(db = getDatabase()) {
    if (initializedDatabases.has(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS local_favorites (
        card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        favorite INTEGER NOT NULL, updated_at INTEGER NOT NULL, change_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS architect_links (
        card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        base_url TEXT NOT NULL, remote_id TEXT NOT NULL,
        PRIMARY KEY (card_id, base_url)
    );
    CREATE TABLE IF NOT EXISTS architect_export_retries (
        card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        base_url TEXT NOT NULL, next_attempt_at INTEGER NOT NULL,
        PRIMARY KEY (card_id, base_url)
    );`);
    initializedDatabases.add(db);
}

export function readFavorite(cardId) {
    const db = getDatabase();
    ensureFavoriteTables(db);
    const row = db.prepare('SELECT * FROM local_favorites WHERE card_id = ?').get(cardId);
    if (row) return { favorite: !!row.favorite, updatedAt: row.updated_at, changeId: row.change_id };
    const card = db.prepare('SELECT favorited FROM cards WHERE id = ?').get(cardId);
    if (!card) throw new Error('Card not found');
    return { favorite: !!card.favorited, updatedAt: 0, changeId: '' };
}

export async function saveFavorite(cardId, favorite, incoming) {
    const previous = readFavorite(cardId);
    const next = incoming || { favorite, updatedAt: Math.max(Date.now(), previous.updatedAt + 1), changeId: randomUUID() };
    if (!isFavoriteState(next)) throw new Error('Invalid favorite state');
    if (incoming && compareFavoriteStates(next, previous) <= 0) return previous;
    const db = getDatabase();
    db.transaction(() => {
        db.prepare(`INSERT INTO local_favorites VALUES (?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET
            favorite=excluded.favorite, updated_at=excluded.updated_at, change_id=excluded.change_id`)
            .run(cardId, next.favorite ? 1 : 0, next.updatedAt, next.changeId);
        db.prepare('UPDATE cards SET favorited = ? WHERE id = ?').run(next.favorite ? 1 : 0, cardId);
    })();
    await setCardFavoriteFlag(cardId, next.favorite);
    invalidateCache();
    return next;
}

export async function linkArchitectCard(cardId, baseUrl, remoteId) {
    ensureFavoriteTables();
    const apiUrl = instanceApiUrl(baseUrl, '').replace(/\/$/, '');
    getDatabase().prepare(`INSERT INTO architect_links VALUES (?, ?, ?) ON CONFLICT(card_id, base_url)
        DO UPDATE SET remote_id=excluded.remote_id`).run(cardId, apiUrl, remoteId);
    // Import the source's current star once, then exchange explicit changes in either direction.
    const current = readFavorite(cardId);
    if (!current.updatedAt) await saveFavorite(cardId, current.favorite);
}

/** Share one upload between automatic favorites and simultaneous manual sends. */
export async function ensureArchitectCard(cardId, baseUrl) {
    ensureFavoriteTables();
    const apiUrl = instanceApiUrl(baseUrl, '').replace(/\/$/, '');
    const existing = getDatabase().prepare('SELECT remote_id FROM architect_links WHERE card_id = ? AND base_url = ?').get(cardId, apiUrl);
    if (existing) return existing.remote_id;
    const key = `${apiUrl}:${cardId}`;
    if (uploads.has(key)) return uploads.get(key);
    const upload = (async () => {
        const remoteId = await uploadCardPng(cardId, 'architect', { baseUrl: apiUrl });
        await linkArchitectCard(cardId, apiUrl, remoteId);
        return remoteId;
    })().finally(() => uploads.delete(key));
    uploads.set(key, upload);
    return upload;
}

async function uploadPendingFavorites(baseUrl) {
    const db = getDatabase();
    // Explicit local stars are the durable queue. Existing source/Chub favorites
    // are not bulk imported just because a connection was configured.
    const pending = db.prepare(`SELECT f.card_id FROM local_favorites f
        LEFT JOIN architect_links l ON l.card_id=f.card_id AND l.base_url=?
        LEFT JOIN architect_export_retries r ON r.card_id=f.card_id AND r.base_url=?
        WHERE f.favorite=1 AND l.card_id IS NULL AND COALESCE(r.next_attempt_at, 0) <= ?
        ORDER BY f.updated_at LIMIT 20`).all(baseUrl, baseUrl, Date.now());
    for (const { card_id: cardId } of pending) {
        if (!readFavorite(cardId).favorite) continue;
        try {
            await ensureArchitectCard(cardId, baseUrl);
        } catch (error) {
            db.prepare(`INSERT INTO architect_export_retries VALUES (?, ?, ?)
                ON CONFLICT(card_id, base_url) DO UPDATE SET next_attempt_at=excluded.next_attempt_at`)
                .run(cardId, baseUrl, Date.now() + 60000);
            log.warn(`Architect upload pending for card ${cardId}: ${error.message}`);
            if (axios.isAxiosError(error) && (!error.response || error.response.status >= 500)) break;
        }
    }
}

export async function reconcileFavorites() {
    if (running) return running;
    running = (async () => {
        ensureFavoriteTables();
        if (!appConfig.characterArchitect?.url || appConfig.characterArchitect.enabled === false) return;
        const baseUrl = instanceApiUrl(appConfig.characterArchitect.url, '').replace(/\/$/, '');
        await uploadPendingFavorites(baseUrl);
        const links = getDatabase().prepare('SELECT * FROM architect_links WHERE base_url = ?').all(baseUrl);
        for (let offset = 0; offset < links.length; offset += 200) {
            const batch = links.slice(offset, offset + 200);
            try {
                const { data } = await axios.post(instanceApiUrl(baseUrl, 'favorites/sync'), {
                    cards: batch.map(link => ({ cardId: link.remote_id, state: readFavorite(link.card_id) }))
                }, { timeout: 5000, maxRedirects: 0 });
                if (!Array.isArray(data?.cards)) throw new Error('Architect needs the direct favorites update');
                for (const remote of data.cards) {
                    const link = batch.find(item => item.remote_id === remote.cardId);
                    if (link && isFavoriteState(remote.state)) {
                        // saveFavorite compares against the current local state, including in-flight clicks.
                        await saveFavorite(link.card_id, remote.state.favorite, remote.state);
                    }
                }
            } catch (error) {
                log.warn(`Favorite sync pending: ${error.message}`);
                break; // Retry this peer later instead of timing out once for every linked card.
            }
        }
    })().finally(() => { running = null; });
    return running;
}

export function startFavoriteSync() {
    const run = () => { void reconcileFavorites().catch(error => log.warn(error.message)); };
    run();
    const timer = setInterval(run, 15000);
    timer.unref();
    return timer;
}
