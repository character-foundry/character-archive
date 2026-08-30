#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { initDatabase } from '../backend/database.js';
import { createCtRepairService } from '../backend/services/CtRepairService.js';
import { syncCharacterTavern } from '../backend/services/scrapers/CtScraper.js';
import { loadConfig, writeJsonAtomically } from '../config-loader.js';

const applyChanges = process.argv.includes('--apply');
const refetch = !process.argv.includes('--no-refetch');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const backupRoot = process.env.CHARACTER_ARCHIVE_BACKUP_DIR || path.join(projectRoot, 'backup');
const staticRoot = process.env.CHARACTER_ARCHIVE_STATIC_DIR || path.join(projectRoot, 'static');
const runRoot = path.join(backupRoot, `ct-repair-${stamp}`);
const quarantineRoot = path.join(runRoot, 'quarantine');
const manifestPath = path.join(runRoot, 'manifest.json');
const databasePath = process.env.CHARACTER_ARCHIVE_DB_FILE
    || path.join(process.env.CHARACTER_ARCHIVE_STATE_DIR || projectRoot, 'cards.db');

const database = applyChanges
    ? initDatabase({ skipTagRebuild: true, skipTokenBackfill: true })
    : new Database(databasePath, { readonly: true, fileMustExist: true });
const hasSyncRuns = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'").get());
const activeRun = hasSyncRuns
    ? database.prepare("SELECT id FROM sync_runs WHERE status IN ('queued','running') LIMIT 1").get()
    : null;
if (activeRun) {
    throw new Error(`Refusing CT repair while sync run ${activeRun.id} is queued or active`);
}

const repair = createCtRepairService(database);
const plan = repair.plan();
const manifest = {
    mode: applyChanges ? 'apply' : 'dry-run',
    createdAt: new Date().toISOString(),
    duplicateGroups: plan.duplicateGroups,
    duplicateRows: plan.duplicateRows,
    groups: plan.groups.map(group => ({
        normalizedPath: group.normalizedPath,
        canonicalId: group.canonicalId,
        metadataDonorId: group.metadataDonorId,
        loserIds: group.loserIds
    })),
    backup: null,
    quarantined: [],
    missingArtifacts: [],
    merge: null,
    refetch: null
};

if (!applyChanges) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    database.close();
    process.exit(0);
}

fs.mkdirSync(runRoot, { recursive: true });
const backupPath = path.join(runRoot, 'cards.db');
await database.backup(backupPath);
manifest.backup = backupPath;
writeJsonAtomically(manifestPath, manifest);

const retiredIds = plan.groups.flatMap(group => group.loserIds);
for (const cardId of retiredIds) {
    const prefix = String(cardId).slice(0, 2);
    for (const suffix of ['.png', '.json', '.card.png', '.charx']) {
        const sourcePath = path.join(staticRoot, prefix, `${cardId}${suffix}`);
        const targetPath = path.join(quarantineRoot, prefix, `${cardId}${suffix}`);
        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.renameSync(sourcePath, targetPath);
            manifest.quarantined.push({ cardId, sourcePath, targetPath });
        } catch (error) {
            if (error.code === 'ENOENT') manifest.missingArtifacts.push(sourcePath);
            else throw error;
        }
        writeJsonAtomically(manifestPath, manifest);
    }
}

manifest.merge = repair.apply(plan);
writeJsonAtomically(manifestPath, manifest);

if (refetch) {
    const config = loadConfig();
    try {
        manifest.refetch = await syncCharacterTavern({
            ...config,
            ctSync: {
                ...(config.ctSync || {}),
                enabled: true,
                fullReconcile: true,
                force: true
            }
        }, progress => {
            if (progress.processed % 100 === 0) {
                process.stdout.write(`CT reconcile: ${progress.processed} processed, ${progress.added} added\n`);
            }
        });
    } catch (error) {
        manifest.refetch = { success: false, error: error.message };
        writeJsonAtomically(manifestPath, manifest);
        throw error;
    }
}

manifest.completedAt = new Date().toISOString();
writeJsonAtomically(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest.merge, refetch: manifest.refetch }, null, 2)}\n`);
