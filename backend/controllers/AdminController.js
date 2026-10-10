
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database.js';
import { readCardPngSpec, getCardFilePaths } from '../utils/card-utils.js';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';
import { resolveTokenCountsFromMetadata, extractTokenCountLabel, normalizeTokenCounts } from '../utils/token-counts.js';
import { appConfig } from '../services/ConfigState.js'; // if needed
import { logger } from '../utils/logger.js';
import { cacheService } from '../services/CacheService.js';

const log = logger.scoped('ADMIN');

// Helper
const STATIC_DIR = path.join(process.cwd(), 'static');

// We need to read metadata from file. Since readMetadataFile was local in server.js,
// let's reimplement it or move it to a util. It's used in CardController too but it wasn't exported.
// CardController reimplemented it locally as getCardMetadata handler logic but didn't export a reusable function.
// Let's make a reusable one in card-utils.js later, but for now locally here.
function readMetadataFile(cardId) {
    const cardIdStr = String(cardId);
    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
    const jsonPath = path.join(subfolder, `${cardIdStr}.json`);

    if (!fs.existsSync(jsonPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(jsonPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        log.error(`Failed to read metadata for ${cardId}`, error);
        return null;
    }
}

// We need to invalidate cache.
// Since queryCache is now in CardController (and TagController has its own),
// we don't have a global cache invalidation mechanism easily accessible here unless we export it or use an event bus.
// For now, we can skip cache invalidation or export a method from CardController if possible.
// Or better, move queryCache to a shared service `CacheService`.
// Given the scope, I'll just log a warning that cache might be stale or ignore it as these are admin tasks.
// Actually, I can import `cardController` and if I made `invalidateQueryCache` a public method I could call it.
// But I didn't.
// Let's just assume admin operations are rare and manual cache clearing (server restart) is acceptable or
// I can refactor CacheService later.

class AdminController {
    backfillTokenCounts = async (req, res) => {
        try {
            const db = getDatabase();

            const query = `
                SELECT id, name
                FROM cards
                WHERE source = 'chub'
                AND tokenDescriptionCount = 0
                AND tokenPersonalityCount = 0
                AND tokenScenarioCount = 0
                AND tokenMesExampleCount = 0
                AND tokenFirstMessageCount = 0
                AND tokenSystemPromptCount = 0
                AND tokenPostHistoryCount = 0
            `;

            const cards = db.prepare(query).all();
            console.log(`[INFO] Found ${cards.length} cards with all zero token counts`);

            if (cards.length === 0) {
                return res.json({ success: true, updated: 0, skipped: 0, noMetadata: 0, message: 'No cards to backfill' });
            }

            const updateStmt = db.prepare(`
                UPDATE cards
                SET tokenDescriptionCount = ?,
                    tokenPersonalityCount = ?,
                    tokenScenarioCount = ?,
                    tokenMesExampleCount = ?,
                    tokenFirstMessageCount = ?,
                    tokenSystemPromptCount = ?,
                    tokenPostHistoryCount = ?
                WHERE id = ?
            `);

            let updated = 0;
            let skipped = 0;
            let noMetadata = 0;

            // Use transaction for bulk updates
            const updateMany = db.transaction(() => {
                for (let i = 0; i < cards.length; i++) {
                    const card = cards[i];

                    if (i % 500 === 0) {
                        console.log(`[PROGRESS] Processing ${i}/${cards.length} (updated: ${updated}, skipped: ${skipped}, no metadata: ${noMetadata})`);
                    }

                    const metadata = readMetadataFile(card.id);
                    if (!metadata) {
                        noMetadata++;
                        continue;
                    }

                    // For backfill, parse directly from labels to bypass existing zero tokenCounts
                    let counts = null;
                    if (metadata.labels) {
                        const parsed = extractTokenCountLabel(metadata.labels);
                        if (parsed) {
                            counts = normalizeTokenCounts(parsed);
                        }
                    }

                    if (!counts) {
                        skipped++;
                        continue;
                    }

                    // Update database
                    updateStmt.run(
                        counts.tokenDescriptionCount ?? 0,
                        counts.tokenPersonalityCount ?? 0,
                        counts.tokenScenarioCount ?? 0,
                        counts.tokenMesExampleCount ?? 0,
                        counts.tokenFirstMessageCount ?? 0,
                        counts.tokenSystemPromptCount ?? 0,
                        counts.tokenPostHistoryCount ?? 0,
                        card.id
                    );

                    // Update JSON file to match database
                    metadata.tokenCounts = counts;
                    metadata.tokenDescriptionCount = counts.tokenDescriptionCount ?? 0;
                    metadata.tokenPersonalityCount = counts.tokenPersonalityCount ?? 0;
                    metadata.tokenScenarioCount = counts.tokenScenarioCount ?? 0;
                    metadata.tokenMesExampleCount = counts.tokenMesExampleCount ?? 0;
                    metadata.tokenFirstMessageCount = counts.tokenFirstMessageCount ?? 0;
                    metadata.tokenSystemPromptCount = counts.tokenSystemPromptCount ?? 0;
                    metadata.tokenPostHistoryCount = counts.tokenPostHistoryCount ?? 0;

                    const cardIdStr = String(card.id);
                    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
                    const jsonPath = path.join(subfolder, `${cardIdStr}.json`);
                    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');

                    updated++;
                }
            });

            updateMany();

            console.log(`[INFO] Token count backfill complete: updated ${updated}, skipped ${skipped}, no metadata ${noMetadata}`);
            cacheService.flush();

            res.json({
                success: true,
                updated,
                skipped,
                noMetadata,
                message: `Backfilled ${updated} cards`
            });
        } catch (error) {
            log.error('Token count backfill error', error);
            res.status(500).json({ success: false, message: error.message || 'Failed to backfill token counts' });
        }
    };

    backfillFeatureFlags = async (req, res) => {
        try {
            const db = getDatabase();

            // Get all Chub cards
            const cards = db.prepare(`SELECT id, name FROM cards WHERE source = 'chub'`).all();
            console.log(`[INFO] Backfilling feature flags for ${cards.length} cards`);

            if (cards.length === 0) {
                return res.json({ success: true, updated: 0, skipped: 0, message: 'No cards to backfill' });
            }

            let updated = 0;
            let skipped = 0;

            const updateStmt = db.prepare(`
                UPDATE cards
                SET hasAlternateGreetings = ?,
                    hasEmbeddedLorebook = ?,
                    hasLinkedLorebook = ?,
                    hasLorebook = ?,
                    hasExampleDialogues = ?,
                    hasSystemPrompt = ?,
                    hasGallery = ?
                WHERE id = ?
            `);

            const updateMany = db.transaction(() => {
                for (let i = 0; i < cards.length; i++) {
                    const card = cards[i];

                    if (i % 1000 === 0) {
                        console.log(`[PROGRESS] Processing ${i}/${cards.length} (updated: ${updated}, skipped: ${skipped})`);
                    }

                    try {
                        // Read card data from PNG
                        const spec = readCardPngSpec(card.id);
                        if (!spec || !spec.data) {
                            skipped++;
                            continue;
                        }

                        // Derive feature flags from spec
                        const flags = deriveFeatures(spec);

                        // Update database
                        updateStmt.run(
                            flags.hasAlternateGreetings ? 1 : 0,
                            flags.hasEmbeddedLorebook ? 1 : 0,
                            flags.hasLinkedLorebook ? 1 : 0,
                            flags.hasLorebook ? 1 : 0,
                            flags.hasExampleDialogues ? 1 : 0,
                            flags.hasSystemPrompt ? 1 : 0,
                            flags.hasGallery ? 1 : 0,
                            card.id
                        );

                        // Update JSON file
                        const metadata = readMetadataFile(card.id);
                        if (metadata) {
                            metadata.hasAlternateGreetings = flags.hasAlternateGreetings;
                            metadata.hasEmbeddedLorebook = flags.hasEmbeddedLorebook;
                            metadata.hasLinkedLorebook = flags.hasLinkedLorebook;
                            metadata.hasLorebook = flags.hasLorebook;
                            metadata.hasExampleDialogues = flags.hasExampleDialogues;
                            metadata.hasSystemPrompt = flags.hasSystemPrompt;
                            metadata.hasGallery = flags.hasGallery;

                            const cardIdStr = String(card.id);
                            const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
                            const jsonPath = path.join(subfolder, `${cardIdStr}.json`);
                            fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                        }

                        updated++;
                    } catch (error) {
                        log.error(`Failed to process card ${card.id}`, error);
                        skipped++;
                    }
                }
            });

            updateMany();

            console.log(`[INFO] Feature flag backfill complete: updated ${updated}, skipped ${skipped}`);
            cacheService.flush();

            res.json({
                success: true,
                updated,
                skipped,
                message: `Backfilled ${updated} cards`
            });
        } catch (error) {
            log.error('Feature flag backfill error', error);
            res.status(500).json({ success: false, message: error.message || 'Failed to backfill feature flags' });
        }
    };
}

export const adminController = new AdminController();
