#!/usr/bin/env node
import os from 'os';

import { initDatabase } from '../backend/database.js';
import { getSyncRunRepository } from '../backend/db/repositories/SyncRunRepository.js';
import { createArchiveSyncService } from '../backend/services/ArchiveSyncService.js';
import { createArchiveSourceHandlers, getEnabledArchiveSources } from '../backend/services/ArchiveSourceHandlers.js';
import { loadConfig } from '../config-loader.js';
import { logger } from '../backend/utils/logger.js';

const log = logger.scoped('ARCHIVE:WORKER');
const workerId = process.env.ARCHIVE_WORKER_ID || `${os.hostname()}:${process.pid}`;
const pollMs = Math.max(250, Number(process.env.ARCHIVE_WORKER_POLL_MS) || 2000);
const runOnce = process.argv.includes('--once');

initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const repository = getSyncRunRepository();
const service = createArchiveSyncService({
    repository,
    sourceHandlers: createArchiveSourceHandlers()
});

function enqueueCurrentBoundary(triggerType) {
    const config = loadConfig();
    if (!config.autoUpdateMode) return null;
    const run = service.enqueueBoundary({
        sources: getEnabledArchiveSources(config),
        triggerType
    });
    log.info(`Boundary ${run.schedule_key} is ${run.status} as run ${run.id}`);
    return run;
}

async function tick() {
    const now = new Date();
    const boundary = service.getBoundary(now).toISOString();
    const config = loadConfig();
    if (config.autoUpdateMode) {
        service.enqueueBoundary({ now, sources: getEnabledArchiveSources(config), triggerType: 'scheduled' });
    }

    const run = repository.claimNext({ workerId, leaseSeconds: 180 });
    if (!run) return false;
    log.info(`Claimed sync run ${run.id} (${run.trigger_type}, boundary=${run.schedule_key || boundary})`);
    const result = await service.execute(run.id, { workerId, config, leaseSeconds: 180 });
    log.info(`Sync run ${run.id} finished ${result.status} (added=${result.added}, updated=${result.updated}, errors=${result.errors})`);
    return true;
}

async function main() {
    enqueueCurrentBoundary('startup-catchup');
    do {
        try {
            await tick();
        } catch (error) {
            log.error('Archive worker tick failed', error);
        }
        if (runOnce) break;
        await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (true);
}

main().catch(error => {
    log.error('Archive worker stopped', error);
    process.exitCode = 1;
});
