import { logger } from '../utils/logger.js';

const log = logger.scoped('ARCHIVE:SYNC');
export const ARCHIVE_SOURCE_ORDER = Object.freeze(['chub', 'ct', 'risuai', 'wyvern']);
const TERMINAL = new Set(['success', 'partial', 'failed', 'cancelled', 'skipped']);
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

class LeaseLostError extends Error {}

function normalizeOutcome(result = {}) {
    const errors = Number(result.errors || 0);
    return {
        status: result.cancelled
            ? 'cancelled'
            : result.skipped === true
                ? 'skipped'
            : result.success === false
                ? 'failed'
                : errors > 0 ? 'partial' : 'success',
        added: Number(result.added ?? result.newCards ?? 0),
        updated: Number(result.updated ?? result.updatedCards ?? 0),
        skipped: Number(result.skipped || 0),
        errors,
        cursor: result.cursor ?? null
    };
}

export function createArchiveSyncService({ repository, sourceHandlers, logger: serviceLog = log }) {
    if (!repository) throw new Error('Sync run repository is required');
    const handlers = sourceHandlers || {};

    return {
        getBoundary(now = new Date()) {
            const timestamp = new Date(now).getTime();
            return new Date(Math.floor(timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS);
        },

        getNextBoundary(now = new Date()) {
            return new Date(this.getBoundary(now).getTime() + FOUR_HOURS_MS);
        },

        enqueueBoundary({ now = new Date(), sources, triggerType = 'scheduled' } = {}) {
            const boundary = this.getBoundary(now).toISOString();
            return repository.enqueue({
                triggerType,
                scheduleKey: boundary,
                scheduledFor: boundary,
                sources
            });
        },

        async execute(runId, { workerId, config = {}, leaseSeconds = 120, heartbeatIntervalMs } = {}) {
            let run = repository.get(runId);
            if (!run) throw new Error(`Sync run ${runId} not found`);
            if (run.status !== 'running') throw new Error(`Sync run ${runId} is not claimed`);

            const requested = new Set(run.requested_sources);
            const orderedSources = [
                ...ARCHIVE_SOURCE_ORDER.filter(source => requested.has(source)),
                ...run.requested_sources.filter(source => !ARCHIVE_SOURCE_ORDER.includes(source))
            ];

            for (const source of orderedSources) {
                run = repository.get(runId);
                const existing = run.sources.find(item => item.source === source);
                if (existing && TERMINAL.has(existing.status)) continue;

                if (repository.isCancellationRequested(runId)) {
                    repository.finishSource(runId, source, { status: 'cancelled' });
                    for (const remaining of orderedSources.slice(orderedSources.indexOf(source) + 1)) {
                        const state = repository.get(runId).sources.find(item => item.source === remaining);
                        if (!state || !TERMINAL.has(state.status)) {
                            repository.finishSource(runId, remaining, { status: 'cancelled' });
                        }
                    }
                    break;
                }

                const handler = handlers[source];
                if (typeof handler !== 'function') {
                    repository.finishSource(runId, source, {
                        status: 'skipped',
                        error: `No handler configured for ${source}`
                    });
                    continue;
                }

                repository.startSource(runId, source);
                if (!repository.renewLease(runId, { workerId, leaseSeconds })) {
                    throw new LeaseLostError(`Archive worker ${workerId} lost lease for run ${runId}`);
                }
                const heartbeatMs = Math.max(5, Number(heartbeatIntervalMs) || Math.floor(leaseSeconds * 1000 / 3));
                let leaseError = null;
                const heartbeat = setInterval(() => {
                    try {
                        if (!repository.renewLease(runId, { workerId, leaseSeconds })) {
                            leaseError = new LeaseLostError(`Archive worker ${workerId} lost lease for run ${runId}`);
                        }
                    } catch (error) {
                        leaseError = new LeaseLostError(`Archive worker ${workerId} could not renew run ${runId}: ${error.message}`);
                    }
                }, heartbeatMs);
                heartbeat.unref?.();
                const progress = payload => {
                    repository.appendEvent(runId, source, 'progress', payload || {});
                    repository.renewLease(runId, { workerId, leaseSeconds });
                };

                try {
                    const result = await handler({
                        runId,
                        source,
                        config,
                        progress,
                        isCancelled: () => Boolean(leaseError) || repository.isCancellationRequested(runId)
                    });
                    if (leaseError || !repository.renewLease(runId, { workerId, leaseSeconds })) {
                        throw leaseError || new LeaseLostError(`Archive worker ${workerId} lost lease for run ${runId}`);
                    }
                    repository.finishSource(
                        runId,
                        source,
                        repository.isCancellationRequested(runId)
                            ? { status: 'cancelled' }
                            : normalizeOutcome(result)
                    );
                } catch (error) {
                    if (error instanceof LeaseLostError) throw error;
                    const message = error?.message || String(error);
                    serviceLog.error(`${source} sync failed in run ${runId}`, error);
                    repository.finishSource(runId, source, {
                        status: 'failed',
                        errors: 1,
                        error: message
                    });
                } finally {
                    clearInterval(heartbeat);
                }
            }

            repository.cleanup(180);
            return repository.finalize(runId);
        }
    };
}
