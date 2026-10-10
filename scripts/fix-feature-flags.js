#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { initDatabase, getDatabase } from '../backend/database.js';
import { STATIC_DIR, getCardFilePaths, readCardPngSpec } from '../backend/utils/card-utils.js';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';

async function main() {
    await initDatabase();
    const db = getDatabase();

    const folders = fs.readdirSync(STATIC_DIR).filter(name => /^\d{2}$/.test(name));

    let processed = 0;
    let updated = 0;
    for (const folder of folders) {
        const fullFolder = `${STATIC_DIR}/${folder}`;
        const files = fs.readdirSync(fullFolder).filter(name => name.endsWith('.json'));
        for (const file of files) {
            const jsonPath = path.join(fullFolder, file);
            const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const cardId = metadata.id || parseInt(file.replace('.json', ''), 10);
            if (!cardId) continue;
            const spec = readCardPngSpec(cardId);
            const specFlags = spec ? deriveFeatures(spec) : {};

            const pick = (key, fallback) => {
                if (typeof specFlags[key] !== 'undefined') return specFlags[key];
                if (typeof metadata[key] !== 'undefined') return Boolean(metadata[key]);
                return Boolean(fallback);
            };

            const hasRelatedExtensions = Array.isArray(metadata.related_extensions) && metadata.related_extensions.length > 0;

            const nextFlags = {
                hasAlternateGreetings: pick('hasAlternateGreetings', false),
                hasEmbeddedLorebook: pick('hasEmbeddedLorebook', false),
                hasLinkedLorebook: pick('hasLinkedLorebook', metadata.hasLinkedLorebook || (metadata.related_lorebooks && metadata.related_lorebooks.length > 0)),
                hasExampleDialogues: pick('hasExampleDialogues', false),
                hasSystemPrompt: pick('hasSystemPrompt', false),
                hasGallery: pick('hasGallery', metadata.hasGallery),
                hasEmbeddedImages: pick('hasEmbeddedImages', false),
                hasExpressions: pick('hasExpressions', hasRelatedExtensions)
            };
            nextFlags.hasLorebook = Boolean(nextFlags.hasEmbeddedLorebook || nextFlags.hasLinkedLorebook || metadata.hasLorebook);

            const hasChanged = Object.keys(nextFlags).some(key => Boolean(metadata[key]) !== nextFlags[key]);
            if (hasChanged) {
                Object.assign(metadata, nextFlags);
                fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 4));
                db.prepare(
                    `UPDATE cards SET
                        hasAlternateGreetings = ?,
                        hasLorebook = ?,
                        hasEmbeddedLorebook = ?,
                        hasLinkedLorebook = ?,
                        hasExampleDialogues = ?,
                        hasSystemPrompt = ?,
                        hasGallery = ?,
                        hasEmbeddedImages = ?,
                        hasExpressions = ?
                    WHERE id = ?`
                ).run(
                    nextFlags.hasAlternateGreetings ? 1 : 0,
                    nextFlags.hasLorebook ? 1 : 0,
                    nextFlags.hasEmbeddedLorebook ? 1 : 0,
                    nextFlags.hasLinkedLorebook ? 1 : 0,
                    nextFlags.hasExampleDialogues ? 1 : 0,
                    nextFlags.hasSystemPrompt ? 1 : 0,
                    nextFlags.hasGallery ? 1 : 0,
                    nextFlags.hasEmbeddedImages ? 1 : 0,
                    nextFlags.hasExpressions ? 1 : 0,
                    cardId
                );
                updated += 1;
            }
            processed += 1;
        }
    }

    console.log(`[INFO] Processed ${processed} metadata files; updated ${updated} feature flag sets.`);
}

main().catch(err => {
    console.error('[ERROR] Failed to fix feature flags:', err);
    process.exit(1);
});
