import { getDatabase } from '../../database.js';

const TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'cancelled', 'skipped']);

function isoNow(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === 'string' && now) return new Date(now).toISOString();
    return new Date().toISOString();
}

function addSeconds(iso, seconds) {
    return new Date(new Date(iso).getTime() + Math.max(1, seconds) * 1000).toISOString();
}

function parseJson(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeSources(sources) {
    const requested = Array.isArray(sources) ? sources : [];
    return [...new Set(requested.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function hydrateRun(database, row) {
    if (!row) return null;
    const sources = database.prepare(`
        SELECT source, status, started_at, finished_at, added, updated, skipped, errors, cursor, error_message
        FROM sync_source_runs
        WHERE run_id = ?
        ORDER BY id ASC
    `).all(row.id);
    return {
        ...row,
        cancel_requested: Boolean(row.cancel_requested),
        requested_sources: parseJson(row.requested_sources, []),
        error_summary: parseJson(row.error_summary, row.error_summary || null),
        sources
    };
}

export function createSyncRunRepository(database) {
    const enqueueTransaction = database.transaction(options => {
        const sources = normalizeSources(options.sources);
        if (sources.length === 0) {
            throw new Error('At least one sync source is required');
        }
        const triggerType = options.triggerType || 'manual';
        const requestedAt = isoNow(options.requestedAt);
        const result = database.prepare(`
            INSERT INTO sync_runs (
                trigger_type, schedule_key, requested_sources, scheduled_for, requested_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(schedule_key) DO NOTHING
        `).run(
            triggerType,
            options.scheduleKey || null,
            JSON.stringify(sources),
            options.scheduledFor ? isoNow(options.scheduledFor) : null,
            requestedAt
        );

        let runId = Number(result.lastInsertRowid);
        if (result.changes === 0 && options.scheduleKey) {
            runId = database.prepare('SELECT id FROM sync_runs WHERE schedule_key = ?').get(options.scheduleKey)?.id;
        }
        if (!runId) throw new Error('Failed to enqueue sync run');

        const insertSource = database.prepare(`
            INSERT OR IGNORE INTO sync_source_runs (run_id, source) VALUES (?, ?)
        `);
        for (const source of sources) insertSource.run(runId, source);
        return runId;
    });

    const claimTransaction = database.transaction(({ workerId, now, leaseSeconds }) => {
        const claimedAt = isoNow(now);
        const row = database.prepare(`
            SELECT id
            FROM sync_runs
            WHERE status = 'queued'
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, requested_at ASC, id ASC
            LIMIT 1
        `).get(claimedAt);
        if (!row) return null;

        database.prepare(`
            UPDATE sync_runs
            SET status = 'running',
                started_at = COALESCE(started_at, ?),
                lease_owner = ?,
                lease_expires_at = ?
            WHERE id = ?
        `).run(claimedAt, workerId, addSeconds(claimedAt, leaseSeconds), row.id);
        return row.id;
    });

    return {
        enqueue(options = {}) {
            const id = enqueueTransaction(options);
            return hydrateRun(database, database.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id));
        },

        get(id) {
            return hydrateRun(database, database.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id));
        },

        list({ limit = 25 } = {}) {
            const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
            return database.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?')
                .all(safeLimit)
                .map(row => hydrateRun(database, row));
        },

        latest() {
            const row = database.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
            return hydrateRun(database, row);
        },

        claimNext({ workerId, now, leaseSeconds = 120 } = {}) {
            if (!workerId) throw new Error('workerId is required to claim a sync run');
            const id = claimTransaction({ workerId, now, leaseSeconds });
            return id ? this.get(id) : null;
        },

        renewLease(id, { workerId, now, leaseSeconds = 120 } = {}) {
            const renewedAt = isoNow(now);
            const result = database.prepare(`
                UPDATE sync_runs
                SET lease_expires_at = ?
                WHERE id = ? AND status = 'running' AND lease_owner = ?
            `).run(addSeconds(renewedAt, leaseSeconds), id, workerId);
            return result.changes === 1;
        },

        requestCancel(id) {
            return database.prepare(`
                UPDATE sync_runs SET cancel_requested = 1 WHERE id = ? AND status IN ('queued','running')
            `).run(id).changes === 1;
        },

        isCancellationRequested(id) {
            return Boolean(database.prepare('SELECT cancel_requested FROM sync_runs WHERE id = ?').get(id)?.cancel_requested);
        },

        startSource(runId, source, now) {
            const startedAt = isoNow(now);
            database.prepare(`
                INSERT INTO sync_source_runs (run_id, source, status, started_at)
                VALUES (?, ?, 'running', ?)
                ON CONFLICT(run_id, source) DO UPDATE SET
                    status = 'running', started_at = COALESCE(sync_source_runs.started_at, excluded.started_at),
                    finished_at = NULL, error_message = NULL
            `).run(runId, source, startedAt);
            database.prepare('UPDATE sync_runs SET current_source = ? WHERE id = ?').run(source, runId);
            return this.get(runId);
        },

        finishSource(runId, source, outcome = {}, now) {
            const status = outcome.status || ((outcome.errors || 0) > 0 ? 'partial' : 'success');
            if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal source status: ${status}`);
            database.prepare(`
                INSERT INTO sync_source_runs (
                    run_id, source, status, started_at, finished_at, added, updated, skipped, errors, cursor, error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, source) DO UPDATE SET
                    status = excluded.status,
                    started_at = COALESCE(sync_source_runs.started_at, excluded.started_at),
                    finished_at = excluded.finished_at,
                    added = excluded.added,
                    updated = excluded.updated,
                    skipped = excluded.skipped,
                    errors = excluded.errors,
                    cursor = excluded.cursor,
                    error_message = excluded.error_message
            `).run(
                runId,
                source,
                status,
                isoNow(outcome.startedAt || now),
                isoNow(now),
                Number(outcome.added || outcome.newCards || 0),
                Number(outcome.updated || outcome.updatedCards || 0),
                Number(outcome.skipped || 0),
                Number(outcome.errors || (status === 'failed' ? 1 : 0)),
                outcome.cursor == null ? null : String(outcome.cursor),
                outcome.error ? String(outcome.error) : null
            );
            return this.get(runId);
        },

        appendEvent(runId, source, eventType, payload = {}) {
            const result = database.prepare(`
                INSERT INTO sync_run_events (run_id, source, event_type, payload)
                VALUES (?, ?, ?, ?)
            `).run(runId, source || null, eventType, JSON.stringify(payload));
            return Number(result.lastInsertRowid);
        },

        listEvents(runId, afterId = 0, limit = 500) {
            return database.prepare(`
                SELECT id, run_id, source, event_type, payload, created_at
                FROM sync_run_events
                WHERE run_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
            `).all(runId, Number(afterId) || 0, Math.max(1, Math.min(Number(limit) || 500, 1000)))
                .map(row => ({ ...row, payload: parseJson(row.payload, {}) }));
        },

        finishRun(id, status, errorSummary = null, now) {
            if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal run status: ${status}`);
            database.prepare(`
                UPDATE sync_runs
                SET status = ?, finished_at = ?, current_source = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, error_summary = ?
                WHERE id = ?
            `).run(status, isoNow(now), errorSummary == null ? null : JSON.stringify(errorSummary), id);
            return this.get(id);
        },

        finalize(id, now) {
            const run = this.get(id);
            if (!run) throw new Error(`Sync run ${id} not found`);
            const outcomes = run.sources;
            const totals = outcomes.reduce((acc, source) => {
                acc.added += source.added || 0;
                acc.updated += source.updated || 0;
                acc.skipped += source.skipped || 0;
                acc.errors += source.errors || 0;
                return acc;
            }, { added: 0, updated: 0, skipped: 0, errors: 0 });

            let status;
            if (run.cancel_requested || outcomes.some(source => source.status === 'cancelled')) {
                status = 'cancelled';
            } else {
                const completed = outcomes.filter(source => TERMINAL_STATUSES.has(source.status));
                const successes = completed.filter(source => source.status === 'success').length;
                const problems = completed.filter(source => source.status === 'failed' || source.status === 'partial').length;
                if (completed.length > 0 && completed.every(source => source.status === 'skipped')) status = 'skipped';
                else if (problems === 0) status = 'success';
                else if (successes > 0 || completed.some(source => source.status === 'skipped')) status = 'partial';
                else status = 'failed';
            }

            const failures = outcomes
                .filter(source => source.error_message)
                .map(source => ({ source: source.source, error: source.error_message }));
            database.prepare(`
                UPDATE sync_runs
                SET added = ?, updated = ?, skipped = ?, errors = ?
                WHERE id = ?
            `).run(totals.added, totals.updated, totals.skipped, totals.errors, id);
            return this.finishRun(id, status, failures.length ? failures : null, now);
        },

        cleanup(retentionDays = 180, now) {
            const cutoff = new Date(new Date(isoNow(now)).getTime() - Math.max(1, retentionDays) * 86400000).toISOString();
            return database.prepare(`
                DELETE FROM sync_runs
                WHERE finished_at IS NOT NULL AND finished_at < ?
            `).run(cutoff).changes;
        }
    };
}

export function getSyncRunRepository() {
    return createSyncRunRepository(getDatabase());
}
