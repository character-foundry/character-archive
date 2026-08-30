import crypto from 'crypto';
import { getDatabase } from '../../database.js';

function isoNow(value) {
    return value ? new Date(value).toISOString() : new Date().toISOString();
}

function addSeconds(value, seconds) {
    return new Date(new Date(value).getTime() + seconds * 1000).toISOString();
}

function safeName(value) {
    return String(value || 'vector').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function baseIndexName(value, fallback) {
    return safeName(value || fallback).replace(/_g\d+$/i, '');
}

function hydrate(database, row) {
    if (!row) return null;
    const counts = database.prepare(`
        SELECT
            COUNT(*) AS total_items,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_items,
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_items,
            SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry_items,
            SUM(CASE WHEN status = 'leased' OR status = 'submitted' THEN 1 ELSE 0 END) AS running_items,
            SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead_items
        FROM vector_work_items WHERE generation_id = ?
    `).get(row.id);
    return {
        ...row,
        active: Boolean(row.active),
        quality_report: row.quality_report ? JSON.parse(row.quality_report) : null,
        ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value || 0)]))
    };
}

export function createVectorGenerationRepository(database) {
    const reconcileTransaction = database.transaction(spec => {
        const wantsChunks = spec.chunksIndexBase !== '' && spec.chunksEnabled !== false;
        const reusableStatuses = spec.forceNewGeneration
            ? ['building', 'ready']
            : ['building', 'ready', 'active'];
        const statusPlaceholders = reusableStatuses.map(() => '?').join(',');
        const existing = database.prepare(`
            SELECT * FROM vector_generations
            WHERE model_name = ? AND embedder_name = ? AND dimensions = ?
              AND status IN (${statusPlaceholders})
            ORDER BY id DESC
        `).all(spec.modelName, spec.embedderName, spec.dimensions, ...reusableStatuses)
            .find(row => Boolean(row.chunks_index) === wantsChunks);
        if (existing) return existing.id;

        const failed = database.prepare(`
            SELECT * FROM vector_generations
            WHERE model_name = ? AND embedder_name = ? AND dimensions = ? AND status = 'failed'
            ORDER BY id DESC
        `).all(spec.modelName, spec.embedderName, spec.dimensions)
            .find(row => Boolean(row.chunks_index) === wantsChunks);
        if (failed) {
            database.prepare(`
                UPDATE vector_work_items
                SET status = 'retry', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP,
                    lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
                    completed_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE generation_id = ? AND status = 'dead'
            `).run(failed.id);
            database.prepare(`
                UPDATE vector_generations
                SET status = 'building', failed_items = 0, last_error = NULL, completed_at = NULL
                WHERE id = ?
            `).run(failed.id);
            return failed.id;
        }

        const fingerprint = crypto.createHash('sha256')
            .update(`${spec.modelName}\0${spec.embedderName}\0${spec.dimensions}`)
            .digest('hex').slice(0, 10);
        const nameBase = spec.name || `${safeName(spec.embedderName)}-${spec.dimensions}-${fingerprint}`;
        const placeholder = `pending_${process.pid}_${Date.now()}`;
        const result = database.prepare(`
            INSERT INTO vector_generations (
                name, model_name, embedder_name, dimensions, cards_index, chunks_index, expected_cards
            ) VALUES (?, ?, ?, ?, ?, ?, (SELECT COUNT(*) FROM cards))
        `).run(placeholder, spec.modelName, spec.embedderName, spec.dimensions, placeholder, `${placeholder}_chunks`);
        const generationId = Number(result.lastInsertRowid);
        const cardsIndex = `${baseIndexName(spec.cardsIndexBase, 'cards_vsem')}_g${generationId}`;
        const chunksIndex = spec.chunksIndexBase === '' || spec.chunksEnabled === false
            ? null
            : `${baseIndexName(spec.chunksIndexBase, 'card_chunks')}_g${generationId}`;
        database.prepare('UPDATE vector_generations SET name = ?, cards_index = ?, chunks_index = ? WHERE id = ?')
            .run(`${safeName(nameBase)}-g${generationId}`, cardsIndex, chunksIndex, generationId);
        database.prepare(`
            INSERT INTO vector_work_items (generation_id, card_id, action)
            SELECT ?, CAST(id AS TEXT), 'upsert' FROM cards ORDER BY id ASC
        `).run(generationId);
        return generationId;
    });

    const updateGenerationProgress = generationId => {
        const state = database.prepare(`
            SELECT
                SUM(CASE WHEN status = 'completed' AND action = 'upsert' THEN 1 ELSE 0 END) AS indexed,
                SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status NOT IN ('completed','dead') THEN 1 ELSE 0 END) AS remaining,
                MAX(CASE WHEN status = 'completed' THEN card_id END) AS cursor
            FROM vector_work_items WHERE generation_id = ?
        `).get(generationId);
        const remaining = Number(state.remaining || 0);
        const failed = Number(state.failed || 0);
        const nextStatus = remaining === 0 ? (failed > 0 ? 'failed' : 'ready') : null;
        database.prepare(`
            UPDATE vector_generations
            SET indexed_cards = ?, failed_items = ?, cursor_card_id = COALESCE(?, cursor_card_id),
                status = CASE WHEN active = 1 THEN status ELSE COALESCE(?, status) END,
                completed_at = CASE WHEN active = 1 OR ? IS NULL THEN completed_at ELSE CURRENT_TIMESTAMP END
            WHERE id = ?
        `).run(Number(state.indexed || 0), failed, state.cursor || null, nextStatus, nextStatus, generationId);
    };

    return {
        reconcile(spec) {
            const dimensions = Number(spec?.dimensions);
            if (!spec?.modelName || !spec?.embedderName || !Number.isInteger(dimensions) || dimensions <= 0) {
                throw new Error('Vector reconcile requires modelName, embedderName, and a positive integer dimensions value');
            }
            const id = reconcileTransaction({ ...spec, dimensions });
            return this.get(id);
        },

        get(id) {
            return hydrate(database, database.prepare('SELECT * FROM vector_generations WHERE id = ?').get(id));
        },

        list() {
            return database.prepare('SELECT * FROM vector_generations ORDER BY id DESC').all().map(row => hydrate(database, row));
        },

        currentBuild(spec = null) {
            const rows = database.prepare(`
                SELECT * FROM vector_generations
                WHERE status = 'building' OR active = 1
                ORDER BY CASE
                    WHEN active = 1 AND EXISTS (
                        SELECT 1 FROM vector_work_items work
                        WHERE work.generation_id = vector_generations.id
                          AND work.status IN ('queued','retry','leased','submitted')
                    ) THEN 0
                    WHEN status = 'building' THEN 1
                    ELSE 2
                END, id ASC
            `).all();
            const row = !spec ? rows[0] : rows.find(candidate => (
                candidate.model_name === spec.modelName
                && candidate.embedder_name === spec.embedderName
                && Number(candidate.dimensions) === Number(spec.dimensions)
                && Boolean(candidate.chunks_index) === (spec.chunksIndexBase !== '' && spec.chunksEnabled !== false)
            ));
            return hydrate(database, row);
        },

        claimBatch({ generationId, workerId, limit = 100, leaseSeconds = 300, now } = {}) {
            const claimedAt = isoNow(now);
            const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 250));
            const transaction = database.transaction(() => {
                database.prepare(`
                    UPDATE vector_work_items
                    SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                    WHERE generation_id = ? AND status IN ('leased','submitted') AND lease_expires_at <= ?
                `).run(claimedAt, generationId, claimedAt);
                const rows = database.prepare(`
                    SELECT id FROM vector_work_items
                    WHERE generation_id = ? AND status IN ('queued','retry') AND next_attempt_at <= ?
                    ORDER BY id ASC LIMIT ?
                `).all(generationId, claimedAt, safeLimit);
                if (!rows.length) return [];
                const ids = rows.map(row => row.id);
                const placeholders = ids.map(() => '?').join(',');
                database.prepare(`
                    UPDATE vector_work_items
                    SET status = 'leased', attempts = attempts + 1, leased_revision = revision,
                        lease_owner = ?, lease_expires_at = ?, updated_at = ?
                    WHERE id IN (${placeholders})
                `).run(workerId, addSeconds(claimedAt, leaseSeconds), claimedAt, ...ids);
                return database.prepare(`SELECT * FROM vector_work_items WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
            });
            return transaction();
        },

        completeItems(ids, now) {
            if (!ids?.length) return 0;
            const placeholders = ids.map(() => '?').join(',');
            const completedAt = isoNow(now);
            const rows = database.prepare(`SELECT DISTINCT generation_id FROM vector_work_items WHERE id IN (${placeholders})`).all(...ids);
            const changes = database.prepare(`
                UPDATE vector_work_items
                SET status = 'completed', completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
                WHERE id IN (${placeholders}) AND revision = leased_revision
            `).run(completedAt, completedAt, ...ids).changes;
            rows.forEach(row => updateGenerationProgress(row.generation_id));
            return changes;
        },

        releaseItems(ids, now) {
            if (!ids?.length) return 0;
            const placeholders = ids.map(() => '?').join(',');
            const releasedAt = isoNow(now);
            return database.prepare(`
                UPDATE vector_work_items
                SET status = 'retry', attempts = MAX(attempts - 1, 0), next_attempt_at = ?,
                    lease_owner = NULL, lease_expires_at = NULL, meili_task_uids = NULL,
                    last_error = NULL, updated_at = ?, leased_revision = NULL
                WHERE id IN (${placeholders}) AND status IN ('leased','submitted')
                  AND revision = leased_revision
            `).run(releasedAt, releasedAt, ...ids).changes;
        },

        failItems(ids, error, { maxAttempts = 5, now } = {}) {
            if (!ids?.length) return 0;
            const failedAt = isoNow(now);
            const message = error?.message || String(error);
            const placeholders = ids.map(() => '?').join(',');
            const rows = database.prepare(`
                SELECT id, generation_id, attempts
                FROM vector_work_items
                WHERE id IN (${placeholders}) AND revision = leased_revision
            `).all(...ids);
            const update = database.prepare(`
                UPDATE vector_work_items
                SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                    last_error = ?, updated_at = ?
                WHERE id = ? AND revision = leased_revision
            `);
            for (const item of rows) {
                const dead = item.attempts >= maxAttempts;
                const backoff = Math.min(3600, 15 * (2 ** Math.max(0, item.attempts - 1)));
                update.run(dead ? 'dead' : 'retry', addSeconds(failedAt, backoff), message, failedAt, item.id);
            }
            [...new Set(rows.map(row => row.generation_id))].forEach(updateGenerationProgress);
            return rows.length;
        },

        activate(id, { qualityApproved = false, qualityReport = null, now, beforeCommit } = {}) {
            if (!qualityApproved) throw new Error('Vector generation activation requires quality approval');
            const generation = this.get(id);
            if (!generation) throw new Error(`Vector generation ${id} not found`);
            if (generation.status !== 'ready' && generation.status !== 'active') {
                throw new Error(`Vector generation ${id} is ${generation.status}, not ready`);
            }
            const activatedAt = isoNow(now);
            const retireAfter = new Date(new Date(activatedAt).getTime() + 7 * 86400000).toISOString();
            database.transaction(() => {
                database.prepare(`
                    UPDATE vector_generations
                    SET active = 0, status = 'retired', retire_after = ?
                    WHERE active = 1 AND id <> ?
                `).run(retireAfter, id);
                database.prepare(`
                    UPDATE vector_generations
                    SET active = 1, status = 'active', activated_at = ?, quality_report = ?
                    WHERE id = ?
                `).run(activatedAt, qualityReport ? JSON.stringify(qualityReport) : null, id);
                beforeCommit?.();
            })();
            return this.get(id);
        }
    };
}

export function getVectorGenerationRepository() {
    return createVectorGenerationRepository(getDatabase());
}
