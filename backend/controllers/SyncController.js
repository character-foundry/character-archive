import { fetchChubFollows, fetchChubBlockedUsers, syncFavoriteToChub } from '../services/SyncService.js';
import { lockService } from '../services/LockService.js';
import { getDatabase } from '../database.js';
import { getSyncRunRepository } from '../db/repositories/SyncRunRepository.js';
import { logger } from '../utils/logger.js';
import { appConfig } from '../services/ConfigState.js';
import { getEnabledArchiveSources } from '../services/ArchiveSourceHandlers.js';

const log = logger.scoped('SYNC');
const VALID_SOURCES = new Set(['chub', 'ct', 'risuai', 'wyvern']);
const TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'cancelled', 'skipped']);

function resolveSources(value, fallback = null) {
    const requested = Array.isArray(value) ? value : fallback || getEnabledArchiveSources(appConfig);
    const sources = [...new Set(requested.map(source => String(source || '').trim().toLowerCase()).filter(Boolean))];
    const invalid = sources.filter(source => !VALID_SOURCES.has(source));
    if (invalid.length) throw new Error(`Unknown sync source(s): ${invalid.join(', ')}`);
    if (!sources.length) throw new Error('At least one sync source is required');
    return sources;
}

function enqueueRun({ sources, triggerType = 'manual' }) {
    return getSyncRunRepository().enqueue({ triggerType, sources: resolveSources(sources) });
}

async function streamLegacyRun(req, res, sources) {
    const repository = getSyncRunRepository();
    const run = repository.enqueue({ triggerType: 'legacy-api', sources: resolveSources(sources) });
    res.status(202);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ runId: run.id, status: run.status, progress: 0, currentCard: 'Queued' })}\n\n`);

    let eventCursor = 0;
    while (!res.writableEnded && !res.destroyed) {
        const events = repository.listEvents(run.id, eventCursor);
        for (const event of events) {
            eventCursor = event.id;
            res.write(`data: ${JSON.stringify({ runId: run.id, source: event.source, ...event.payload })}\n\n`);
        }
        const current = repository.get(run.id);
        if (!current || TERMINAL_STATUSES.has(current.status)) {
            const payload = current || { id: run.id, status: 'failed', error_summary: 'Run disappeared' };
            const terminalError = ['failed', 'partial'].includes(payload.status)
                ? (Array.isArray(payload.error_summary)
                    ? payload.error_summary.map(item => `${item.source}: ${item.error}`).join('; ')
                    : payload.error_summary || `${payload.errors || 0} source error(s)`)
                : undefined;
            res.write(`data: ${JSON.stringify({
                runId: run.id,
                status: payload.status,
                progress: 100,
                currentCard: `Sync ${payload.status}`,
                newCards: payload.added || 0,
                updatedCards: payload.updated || 0,
                errors: payload.errors || 0,
                error: terminalError
            })}\n\n`);
            res.end();
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

class SyncController {
    streamLegacy = (req, res, sources) => streamLegacyRun(req, res, sources).catch(error => {
        log.error('Legacy archive sync stream failed', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ status: 'failed', progress: 100, error: error.message })}\n\n`);
            res.end();
        }
    });

    async getChubFollows(req, res) {
        try {
            const queryProfile = typeof req.query.profile === 'string' ? req.query.profile : Array.isArray(req.query.profile) ? req.query.profile[0] : '';
            const profile = (queryProfile || appConfig.chubProfileName || '').trim();
            if (!profile) {
                return res.status(400).json({ error: 'Missing Chub profile name' });
            }

            const result = await fetchChubFollows(profile);
            res.json(result);
        } catch (error) {
            log.error('Failed to fetch Chub follows', error);
            res.status(502).json({ error: error?.message || 'Failed to fetch followed creators from Chub' });
        }
    }

    async getChubBlockedUsers(req, res) {
        try {
            const result = await fetchChubBlockedUsers();
            res.json(result);
        } catch (error) {
            log.error('Failed to fetch Chub blocked users', error);
            res.status(502).json({ error: error?.message || 'Failed to fetch blocked users from Chub' });
        }
    }

    createRun = (req, res) => {
        try {
            const run = enqueueRun({ sources: req.body?.sources, triggerType: 'manual' });
            res.location(`/api/sync/runs/${run.id}`).status(202).json(run);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    getRun = (req, res) => {
        const run = getSyncRunRepository().get(Number(req.params.id));
        if (!run) return res.status(404).json({ error: 'Sync run not found' });
        return res.json(run);
    };

    cancelRun = (req, res) => {
        const repository = getSyncRunRepository();
        const run = repository.get(Number(req.params.id));
        if (!run) return res.status(404).json({ error: 'Sync run not found' });
        if (TERMINAL_STATUSES.has(run.status)) {
            return res.status(409).json({ error: `Sync run is already ${run.status}`, run });
        }
        repository.requestCancel(run.id);
        lockService.abortAllSyncs();
        return res.status(202).json(repository.get(run.id));
    };

    getStatus = (req, res) => {
        const repository = getSyncRunRepository();
        const latest = repository.latest();
        const active = repository.list({ limit: 25 }).filter(run => run.status === 'queued' || run.status === 'running');
        const legacy = lockService.getSyncStatus();
        const activeSources = new Set(active.flatMap(run =>
            run.sources
                .filter(sourceRun => sourceRun.status === 'running')
                .map(sourceRun => sourceRun.source)
        ));
        for (const [source, state] of Object.entries(legacy)) {
            state.inProgress = state.inProgress || activeSources.has(source);
        }
        res.json({ ...legacy, latestRun: latest, activeRuns: active });
    };

    cancelAll = (req, res) => {
        const repository = getSyncRunRepository();
        const active = repository.list({ limit: 200 }).filter(run => run.status === 'queued' || run.status === 'running');
        active.forEach(run => repository.requestCancel(run.id));
        lockService.abortAllSyncs();
        res.status(202).json({ success: true, cancelledRunIds: active.map(run => run.id) });
    };

    syncCards = (req, res) => this.streamLegacy(req, res, null);
    syncChub = (req, res) => this.streamLegacy(req, res, ['chub']);
    syncCharacterTavern = (req, res) => this.streamLegacy(req, res, ['ct']);
    syncWyvern = (req, res) => this.streamLegacy(req, res, ['wyvern']);
    syncRisuAi = (req, res) => this.streamLegacy(req, res, ['risuai']);

    async syncFavoritesToChub(req, res) {
        try {
            const apiKey = (appConfig.chubApiKey || '').trim();
            if (!apiKey) {
                return res.status(400).json({ success: false, message: 'Chub API key missing in config' });
            }

            const database = getDatabase();
            const limitValue = Number(req.body?.limit);
            const dryRun = !!req.body?.dryRun;

            let sql = `
                SELECT id, source, sourceId, name
                FROM cards
                WHERE favorited = 1
                  AND (
                      source IS NULL
                      OR LOWER(source) = 'chub'
                      OR LOWER(source) = 'chub.ai'
                  )
                ORDER BY id ASC
            `;

            if (Number.isInteger(limitValue) && limitValue > 0) {
                sql += ` LIMIT ${limitValue}`;
            }

            const favorites = database.prepare(sql).all();
            const stats = {
                total: favorites.length,
                attempted: 0,
                synced: 0,
                failed: 0,
                skipped: 0
            };

            for (const card of favorites) {
                if (dryRun) {
                    stats.skipped += 1;
                    continue;
                }

                stats.attempted += 1;
                const ok = await syncFavoriteToChub(card, true);
                if (ok) {
                    stats.synced += 1;
                } else {
                    stats.failed += 1;
                }
            }

            res.json({
                success: true,
                message: dryRun
                    ? 'Dry run complete – no remote updates sent'
                    : `Synced ${stats.synced} favorite(s) to Chub`,
                stats
            });
        } catch (error) {
            log.error('Favorite sync to Chub failed', error);
            res.status(500).json({ success: false, message: error.message || 'Failed to sync favorites to Chub' });
        }
    }
}

export const syncController = new SyncController();
