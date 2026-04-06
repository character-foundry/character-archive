import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { appConfig } from './ConfigState.js';
import { lockService } from './LockService.js';
import { getDatabase } from '../database.js';

const log = logger.scoped('VECTOR-BACKFILL');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');
const scriptPath = path.join(projectRoot, 'scripts', 'etl_cards_vector_search.js');

let scheduleTimer = null;
let backfillInFlight = false;
let rerunRequested = false;
let pendingReason = null;

function resolveDelayMs() {
    const configured = Number(appConfig?.vectorSearch?.postSyncDelaySeconds || process.env.VECTOR_POST_SYNC_DELAY_SECONDS || 30);
    const boundedSeconds = Math.max(5, Math.min(3600, Number.isFinite(configured) ? configured : 30));
    return boundedSeconds * 1000;
}

function vectorEnabled() {
    return appConfig?.vectorSearch?.enabled === true && appConfig?.meilisearch?.enabled === true;
}

function hasSyncInProgress() {
    return lockService.isSyncInProgress() || lockService.isCtSyncInProgress();
}

function startBackfill(reason) {
    if (!vectorEnabled()) {
        return;
    }
    if (hasSyncInProgress()) {
        scheduleVectorBackfill(reason);
        return;
    }
    try {
        const db = getDatabase();
        const row = db.prepare('SELECT COUNT(*) AS count FROM vector_index_queue').get();
        const queued = row?.count || 0;
        if (queued <= 0) {
            log.info('Vector queue empty; skipping backfill run');
            return;
        }
    } catch (error) {
        log.warn('Unable to check vector queue size; proceeding with backfill', error);
    }
    if (backfillInFlight) {
        rerunRequested = true;
        pendingReason = reason;
        log.info(`Vector backfill already running; queued rerun [reason=${reason}]`);
        return;
    }

    backfillInFlight = true;
    rerunRequested = false;
    log.info(`Vector backfill starting [reason=${reason}]`);

    const env = {
        ...process.env
    };
    const queueBatch = Number(appConfig?.vectorSearch?.postSyncQueueBatch || process.env.VECTOR_POST_SYNC_QUEUE_BATCH || 0);
    const batchLimit = Number.isFinite(queueBatch) && queueBatch > 0 ? Math.floor(queueBatch) : 500;
    let queueRows = [];
    try {
        const db = getDatabase();
        queueRows = db.prepare('SELECT id, cardId, action FROM vector_index_queue ORDER BY id LIMIT ?').all(batchLimit);
    } catch (error) {
        log.error('Failed to read vector queue rows', error);
    }

    if (!queueRows.length) {
        log.info('Vector queue empty; skipping backfill run');
        backfillInFlight = false;
        return;
    }

    const actionMap = new Map();
    for (const row of queueRows) {
        const cardId = String(row.cardId);
        const action = row.action === 'delete' ? 'delete' : 'upsert';
        const existing = actionMap.get(cardId);
        if (!existing || action === 'delete') {
            actionMap.set(cardId, action);
        }
    }

    const deleteIds = [];
    const upsertIds = [];
    actionMap.forEach((action, cardId) => {
        if (action === 'delete') {
            deleteIds.push(cardId);
        } else {
            upsertIds.push(cardId);
        }
    });

    const queueRowIds = queueRows.map(row => row.id);
    if (upsertIds.length) {
        env.LCR_VECTOR_IDS = upsertIds.join(',');
    }
    if (deleteIds.length) {
        env.LCR_VECTOR_DELETE_IDS = deleteIds.join(',');
    }
    env.LCR_VECTOR_QUEUE_IDS = queueRowIds.join(',');

    const child = spawn(process.execPath, [scriptPath], {
        cwd: projectRoot,
        env,
        stdio: 'inherit'
    });

    child.on('exit', (code, signal) => {
        backfillInFlight = false;
        if (code === 0) {
            log.info('Vector backfill completed');
        } else {
            log.warn(`Vector backfill exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        }
        if (rerunRequested) {
            const reasonToUse = pendingReason || 'queued';
            rerunRequested = false;
            scheduleVectorBackfill(reasonToUse, resolveDelayMs());
        }
    });

    child.on('error', (error) => {
        backfillInFlight = false;
        log.error('Vector backfill failed to start', error);
        if (rerunRequested) {
            const reasonToUse = pendingReason || 'queued';
            rerunRequested = false;
            scheduleVectorBackfill(reasonToUse, resolveDelayMs());
        }
    });
}

export function scheduleVectorBackfill(reason = 'sync-complete', delayMs = null) {
    if (!vectorEnabled()) {
        return;
    }
    pendingReason = reason;
    if (scheduleTimer) {
        clearTimeout(scheduleTimer);
    }
    const delay = Number.isFinite(delayMs) ? delayMs : resolveDelayMs();
    scheduleTimer = setTimeout(() => {
        scheduleTimer = null;
        startBackfill(pendingReason || reason);
    }, delay);
    log.info(`Vector backfill scheduled in ${Math.round(delay / 1000)}s [reason=${reason}]`);
}
