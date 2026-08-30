
import { loadConfig } from '../../config-loader.js';
import { syncCards } from './scraper.js';
import { syncCharacterTavern } from './scrapers/CtScraper.js';
import { drainSearchIndexQueue, isSearchIndexEnabled } from './search-index.js';
import { computeDailySnapshot } from './MetricsService.js';
import { lockService } from './LockService.js';
import { scheduleVectorBackfill } from './VectorBackfillService.js';
import { scheduleOptimization } from './PngOptimizationService.js';
import { getDatabase } from '../database.js';
import { logger } from '../utils/logger.js';

const log = logger.scoped('SCHEDULER');

class SchedulerService {
    constructor() {
        this.autoUpdateTimer = null;
        this.ctAutoUpdateTimer = null;
        this.searchIndexRefreshTimer = null;
        this.searchIndexQueueTimer = null;
        this.metricsSnapshotTimer = null;
        this.walCheckpointTimer = null;

        this.SEARCH_INDEX_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
        this.SEARCH_INDEX_QUEUE_INTERVAL_MS = 5000;
        this.WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    }

    startAutoUpdate() {
        if (this.autoUpdateTimer) {
            clearInterval(this.autoUpdateTimer);
            this.autoUpdateTimer = null;
        }

        const currentConfig = loadConfig();
        if (!currentConfig.autoUpdateMode) {
            console.log('[INFO] Auto-update is disabled');
            return;
        }

        const interval = (currentConfig.autoUpdateInterval || 900) * 1000;
        console.log(`[INFO] Auto-update enabled with ${currentConfig.autoUpdateInterval}s interval`);

        this.autoUpdateTimer = setInterval(async () => {
            if (lockService.isSyncInProgress()) {
                console.log('[INFO] Sync already in progress, skipping auto-update');
                return;
            }

            console.log('[INFO] Auto-update triggered');
            lockService.setSyncInProgress(true);
            try {
                await syncCards(loadConfig(), (progress) => {
                    if (progress.progress % 25 === 0 || progress.progress === 100) {
                        console.log(`[INFO] Auto-update progress: ${progress.progress}%`);
                    }
                });
                console.log('[INFO] Auto-update complete');
                await drainSearchIndexQueue('auto-update');
                scheduleVectorBackfill('auto-update');
                scheduleOptimization('auto-update');
            } catch (error) {
                log.error('Auto-update failed', error);
            } finally {
                lockService.setSyncInProgress(false);
            }
        }, interval);
    }

    startCtAutoUpdate() {
        if (this.ctAutoUpdateTimer) {
            clearInterval(this.ctAutoUpdateTimer);
            this.ctAutoUpdateTimer = null;
        }

        const currentConfig = loadConfig();
        const ctConfig = currentConfig.ctSync || {};
        if (!ctConfig.enabled) {
            console.log('[INFO] Character Tavern auto-sync is disabled');
            return;
        }

        const intervalMs = Math.max(1, ctConfig.intervalMinutes || 180) * 60 * 1000;
        console.log(`[INFO] Character Tavern auto-sync enabled with ${ctConfig.intervalMinutes || 180} minute interval`);

        this.ctAutoUpdateTimer = setInterval(async () => {
            if (lockService.isCtSyncInProgress()) {
                console.log('[INFO] CT sync already in progress, skipping auto-sync run');
                return;
            }

            console.log('[INFO] Character Tavern auto-sync triggered');
            lockService.setCtSyncInProgress(true);
            try {
                await syncCharacterTavern(loadConfig(), progress => {
                    if (progress.processed % 25 === 0) {
                        console.log(`[INFO] CT auto-sync processed ${progress.processed} cards (added ${progress.added})`);
                    }
                });
                console.log('[INFO] Character Tavern auto-sync complete');
                await drainSearchIndexQueue('ct-auto-sync');
                scheduleVectorBackfill('ct-auto-sync');
                scheduleOptimization('ct-auto-sync');
            } catch (error) {
                log.error('Character Tavern auto-sync failed', error);
            } finally {
                lockService.setCtSyncInProgress(false);
            }
        }, intervalMs);
    }
    
    startSearchIndexScheduler() {
        if (this.searchIndexRefreshTimer) {
            clearInterval(this.searchIndexRefreshTimer);
            this.searchIndexRefreshTimer = null;
        }
        if (this.searchIndexQueueTimer) {
            clearInterval(this.searchIndexQueueTimer);
            this.searchIndexQueueTimer = null;
        }

        if (!isSearchIndexEnabled()) {
            return;
        }

        this.searchIndexQueueTimer = setInterval(() => {
            if (lockService.isSyncInProgress() || lockService.isCtSyncInProgress()) {
                return;
            }
            drainSearchIndexQueue('interval');
        }, this.SEARCH_INDEX_QUEUE_INTERVAL_MS);
    }

    /**
     * Start the daily metrics snapshot scheduler
     * Computes a snapshot at midnight every day
     */
    startMetricsSnapshotScheduler() {
        if (this.metricsSnapshotTimer) {
            clearTimeout(this.metricsSnapshotTimer);
            this.metricsSnapshotTimer = null;
        }

        const scheduleNextSnapshot = () => {
            const now = new Date();
            const midnight = new Date(now);
            midnight.setDate(midnight.getDate() + 1);
            midnight.setHours(0, 0, 0, 0);

            const msUntilMidnight = midnight.getTime() - now.getTime();

            log.info(`Next metrics snapshot scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

            this.metricsSnapshotTimer = setTimeout(() => {
                try {
                    log.info('Computing daily metrics snapshot...');
                    computeDailySnapshot();
                    log.info('Daily metrics snapshot completed');
                    this.cleanupOldSnapshots();
                } catch (error) {
                    log.error('Failed to compute daily metrics snapshot', error);
                }
                // Schedule the next one
                scheduleNextSnapshot();
            }, msUntilMidnight);
        };

        // Compute an initial snapshot if we don't have one for today
        try {
            computeDailySnapshot();
            log.info('Initial metrics snapshot computed');
        } catch (error) {
            log.error('Failed to compute initial metrics snapshot', error);
        }

        // Run initial cleanup
        this.cleanupOldSnapshots();

        scheduleNextSnapshot();
    }

    /**
     * Delete metrics snapshots older than 90 days
     */
    cleanupOldSnapshots() {
        try {
            const db = getDatabase();
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - 90);
            const cutoffStr = cutoffDate.toISOString().split('T')[0];

            const result = db.prepare(
                'DELETE FROM metrics_snapshots WHERE snapshot_date < ?'
            ).run(cutoffStr);

            if (result.changes > 0) {
                log.info(`Cleaned up ${result.changes} metrics snapshot(s) older than 90 days`);
            }
        } catch (error) {
            log.error('Failed to cleanup old metrics snapshots', error);
        }
    }

    /**
     * Start periodic WAL checkpoint to prevent WAL file from growing too large
     * Runs every hour to truncate the WAL file
     */
    startWalCheckpointScheduler() {
        if (this.walCheckpointTimer) {
            clearInterval(this.walCheckpointTimer);
            this.walCheckpointTimer = null;
        }

        // Run initial checkpoint
        this.runWalCheckpoint();

        // Schedule periodic checkpoints
        this.walCheckpointTimer = setInterval(() => {
            this.runWalCheckpoint();
        }, this.WAL_CHECKPOINT_INTERVAL_MS);

        log.info('WAL checkpoint scheduler started (every 1 hour)');
    }

    /**
     * Run a WAL checkpoint to truncate the WAL file
     */
    runWalCheckpoint() {
        try {
            const db = getDatabase();
            const result = db.pragma('wal_checkpoint(TRUNCATE)');
            const [{ busy, log: walLog, checkpointed }] = result;
            log.info(`WAL checkpoint: busy=${busy}, log=${walLog}, checkpointed=${checkpointed}`);
        } catch (error) {
            log.error('WAL checkpoint failed', error);
        }
    }
}

export const schedulerService = new SchedulerService();
