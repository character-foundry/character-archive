/**
 * Federation Routes
 *
 * Standard federation endpoints + platform config.
 */

import express from 'express';
import { parseActivity, cardFromActivityPub } from '@character-foundry/character-foundry/federation';
import { getActor, syncEngine, baseUrl, getRemoteCardNames } from '../services/FederationService.js';
import { archiveAdapter } from '../services/ArchiveAdapter.js';
import { getDatabase } from '../database.js';

const router = express.Router();

// Register local adapter only if federation is enabled
const federationEnabled = process.env.FEDERATION_ENABLED === 'true';
if (federationEnabled) {
    syncEngine.registerPlatform(archiveAdapter);
}

// GET /api/federation/actor
router.get('/actor', (req, res) => {
    res.json(getActor());
});

// POST /api/federation/inbox
router.post('/inbox', async (req, res) => {
    try {
        const activity = parseActivity(req.body);

        if (activity.type === 'Create' || activity.type === 'Update') {
            const card = typeof activity.object === 'object' && activity.object.content
                ? cardFromActivityPub(activity.object)
                : activity.object?.cardData;

            if (card) {
                const id = await archiveAdapter.saveCard(card);
                return res.status(201).json({ success: true, id });
            }
        }

        if (activity.type === 'Delete') {
            const id = typeof activity.object === 'string' ? activity.object : activity.object?.id;
            if (id) await archiveAdapter.deleteCard(id);
            return res.json({ success: true });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/federation/outbox
router.get('/outbox', async (req, res) => {
    const cards = await archiveAdapter.listCards({
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
    });

    res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        totalItems: cards.length,
        items: cards.map(c => ({
            type: 'Note',
            id: c.id,
            name: c.card.data?.name,
            published: c.updatedAt,
            url: `/api/federation/assets/${c.id}`,
        })),
    });
});

// GET /api/federation/assets/:id
router.get('/assets/:id', async (req, res) => {
    const card = await archiveAdapter.getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'Not found' });
    res.json(card);
});

// ============================================================================
// Platform Configuration (stored in SQLite)
// ============================================================================

// GET /api/federation/platforms
router.get('/platforms', (req, res) => {
    const db = getDatabase();
    const platforms = db.prepare('SELECT * FROM federation_platforms').all();
    res.json({
        platforms: platforms.map(p => ({
            ...p,
            api_key: p.api_key ? '***configured***' : null,
        }))
    });
});

// POST /api/federation/platforms/:platform
router.post('/platforms/:platform', (req, res) => {
    const db = getDatabase();
    const { platform } = req.params;
    const { base_url, api_key, enabled } = req.body;

    const updates = [];
    const params = [];

    if (base_url !== undefined) {
        updates.push('base_url = ?');
        params.push(base_url || null);
    }
    if (api_key !== undefined && api_key !== '') {
        updates.push('api_key = ?');
        params.push(api_key);
    }
    if (enabled !== undefined) {
        updates.push('enabled = ?');
        params.push(enabled ? 1 : 0);
    }

    if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(platform);
        db.prepare(`UPDATE federation_platforms SET ${updates.join(', ')} WHERE platform = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM federation_platforms WHERE platform = ?').get(platform);
    res.json({
        success: true,
        platform: { ...updated, api_key: updated?.api_key ? '***configured***' : null }
    });
});

// POST /api/federation/platforms/:platform/test
router.post('/platforms/:platform/test', async (req, res) => {
    const db = getDatabase();
    const { platform } = req.params;
    const config = db.prepare('SELECT * FROM federation_platforms WHERE platform = ?').get(platform);

    if (!config?.base_url) {
        return res.json({ connected: false, error: 'Platform not configured' });
    }

    try {
        const actorUrl = platform === 'sillytavern'
            ? `${config.base_url}/api/plugins/cforge/federation/actor`
            : `${config.base_url}/api/federation/actor`;

        const response = await fetch(actorUrl, { timeout: 5000 });
        if (response.ok) {
            db.prepare('UPDATE federation_platforms SET last_connected_at = CURRENT_TIMESTAMP WHERE platform = ?').run(platform);
            return res.json({ connected: true, data: await response.json() });
        }
        res.json({ connected: false, error: `HTTP ${response.status}` });
    } catch (error) {
        res.json({ connected: false, error: error.message });
    }
});

export default router;
