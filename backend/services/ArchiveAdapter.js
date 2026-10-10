/**
 * Archive Platform Adapter
 *
 * Implements PlatformAdapter from @character-foundry/character-foundry/federation
 */

import fs from 'fs';
import path from 'path';
import { BasePlatformAdapter } from '@character-foundry/character-foundry/federation';
import { getDatabase } from '../database.js';
import { readCardPngSpec, getCardFilePaths } from '../utils/card-utils.js';

export class ArchiveAdapter extends BasePlatformAdapter {
    platform = 'archive';
    displayName = 'Character Archive';

    async isAvailable() {
        try {
            getDatabase().prepare('SELECT 1').get();
            return true;
        } catch {
            return false;
        }
    }

    async getCard(localId) {
        return readCardPngSpec(localId) || null;
    }

    async listCards(options = {}) {
        const db = getDatabase();
        const { limit = 100, offset = 0 } = options;

        const rows = db.prepare(`
            SELECT id, name, lastModified, createdAt FROM cards
            ORDER BY lastModified DESC LIMIT ? OFFSET ?
        `).all(limit, offset);

        const cards = [];
        for (const row of rows) {
            const card = await this.getCard(row.id);
            if (card) {
                cards.push({
                    id: String(row.id),
                    card,
                    updatedAt: row.lastModified || row.createdAt || new Date().toISOString(),
                });
            }
        }
        return cards;
    }

    async saveCard(card, localId) {
        const db = getDatabase();
        const now = new Date().toISOString();
        const name = card.data?.name || 'Unknown';

        if (localId) {
            db.prepare('UPDATE cards SET name = ?, lastModified = ? WHERE id = ?').run(name, now, localId);
        } else {
            const result = db.prepare('INSERT INTO cards (name, createdAt, lastModified) VALUES (?, ?, ?)').run(name, now, now);
            localId = result.lastInsertRowid;
        }

        const { jsonPath } = getCardFilePaths(localId);
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(card, null, 2));

        return String(localId);
    }

    async deleteCard(localId) {
        const db = getDatabase();
        return db.prepare('DELETE FROM cards WHERE id = ?').run(localId).changes > 0;
    }

    async getAssets(localId) {
        const { pngPath } = getCardFilePaths(localId);
        if (!fs.existsSync(pngPath)) return [];

        return [{
            name: 'avatar',
            type: 'icon',
            data: new Uint8Array(fs.readFileSync(pngPath)),
            mimeType: 'image/png',
        }];
    }

    async getLastModified(localId) {
        const db = getDatabase();
        return db.prepare('SELECT lastModified FROM cards WHERE id = ?').get(localId)?.lastModified || null;
    }
}

export const archiveAdapter = new ArchiveAdapter();
