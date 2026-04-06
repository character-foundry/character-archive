import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { appConfig } from './ConfigState.js';
import { lockService } from './LockService.js';
import { getDatabase } from '../database.js';

const log = logger.scoped('PNG-OPT');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');
const scriptPath = path.join(projectRoot, 'scripts', 'optimize-pngs.js');

let scheduleTimer = null;
let optimizeInFlight = false;
let rerunRequested = false;
let pendingReason = null;

function resolveDelayMs() {
    const configured = Number(
        appConfig?.pngOptimization?.postSyncDelaySeconds
        || process.env.PNG_OPT_POST_SYNC_DELAY_SECONDS
        || 60
    );
    const boundedSeconds = Math.max(5, Math.min(3600, Number.isFinite(configured) ? configured : 60));
    return boundedSeconds * 1000;
}

function optimizationEnabled() {
    return appConfig?.pngOptimization?.enabled !== false;
}

function hasSyncInProgress() {
    return lockService.isSyncInProgress() || lockService.isCtSyncInProgress();
}

function startOptimization(reason) {
    if (!optimizationEnabled()) {
        return;
    }
    if (hasSyncInProgress()) {
        scheduleOptimization(reason);
        return;
    }

    let queued = 0;
    try {
        const db = getDatabase();
        const row = db.prepare('SELECT COUNT(*) AS count FROM png_optimization_queue').get();
        queued = row?.count || 0;
        if (queued <= 0) {
            log.info('PNG optimization queue empty; skipping run');
            return;
        }
    } catch (error) {
        log.warn('Unable to check PNG optimization queue size; proceeding', error);
    }

    if (optimizeInFlight) {
        rerunRequested = true;
        pendingReason = reason;
        log.info(`PNG optimization already running; queued rerun [reason=${reason}]`);
        return;
    }

    optimizeInFlight = true;
    rerunRequested = false;
    log.info(`PNG optimization starting [reason=${reason}, queued=${queued}]`);

    const env = { ...process.env };

    const batchLimit = Number(
        appConfig?.pngOptimization?.batchSize
        || process.env.PNG_OPT_BATCH_SIZE
        || 200
    );
    const safeBatchLimit = Number.isFinite(batchLimit) && batchLimit > 0 ? Math.floor(batchLimit) : 200;

    let queueRows = [];
    try {
        const db = getDatabase();
        queueRows = db.prepare(
            'SELECT q.id, q.cardId FROM png_optimization_queue q ORDER BY q.id LIMIT ?'
        ).all(safeBatchLimit);
    } catch (error) {
        log.error('Failed to read PNG optimization queue rows', error);
    }

    if (!queueRows.length) {
        log.info('PNG optimization queue empty; skipping run');
        optimizeInFlight = false;
        return;
    }

    const cardIds = queueRows.map(row => String(row.cardId));
    const queueRowIds = queueRows.map(row => row.id);

    env.LCR_OPTIMIZE_IDS = cardIds.join(',');
    env.LCR_OPTIMIZE_QUEUE_IDS = queueRowIds.join(',');
    env.LCR_OPTIMIZE_BATCH = String(safeBatchLimit);

    if (appConfig?.pngOptimization?.maxMegapixels) {
        env.LCR_OPTIMIZE_MAX_MP = String(appConfig.pngOptimization.maxMegapixels);
    }
    if (appConfig?.pngOptimization?.compressionLevel != null) {
        env.LCR_OPTIMIZE_COMPRESSION = String(appConfig.pngOptimization.compressionLevel);
    }

    const child = spawn(process.execPath, [scriptPath], {
        cwd: projectRoot,
        env,
        stdio: 'inherit'
    });

    child.on('exit', (code, signal) => {
        optimizeInFlight = false;
        if (code === 0) {
            log.info('PNG optimization completed');
        } else {
            log.warn(`PNG optimization exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        }
        if (rerunRequested) {
            const reasonToUse = pendingReason || 'queued';
            rerunRequested = false;
            scheduleOptimization(reasonToUse, resolveDelayMs());
        }
    });

    child.on('error', (error) => {
        optimizeInFlight = false;
        log.error('PNG optimization failed to start', error);
        if (rerunRequested) {
            const reasonToUse = pendingReason || 'queued';
            rerunRequested = false;
            scheduleOptimization(reasonToUse, resolveDelayMs());
        }
    });
}

export function scheduleOptimization(reason = 'sync-complete', delayMs = null) {
    if (!optimizationEnabled()) {
        return;
    }
    pendingReason = reason;
    if (scheduleTimer) {
        clearTimeout(scheduleTimer);
    }
    const delay = Number.isFinite(delayMs) ? delayMs : resolveDelayMs();
    scheduleTimer = setTimeout(() => {
        scheduleTimer = null;
        startOptimization(pendingReason || reason);
    }, delay);
    log.info(`PNG optimization scheduled in ${Math.round(delay / 1000)}s [reason=${reason}]`);
}
