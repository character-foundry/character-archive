#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import { initDatabase, getDatabase } from '../backend/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const staticDir = path.join(projectRoot, 'static');

// Configuration from env vars
const IDS_FILTER = process.env.LCR_OPTIMIZE_IDS || '';
const QUEUE_ROW_IDS = process.env.LCR_OPTIMIZE_QUEUE_IDS || '';
const BATCH_LIMIT = Number(process.env.LCR_OPTIMIZE_BATCH || 200);
const DRY_RUN = process.env.LCR_OPTIMIZE_DRY_RUN === '1';
const MAX_MEGAPIXELS = Number(process.env.LCR_OPTIMIZE_MAX_MP || 4);
const COMPRESSION_LEVEL = Number(process.env.LCR_OPTIMIZE_COMPRESSION || 9);
const ALL_MODE = process.argv.includes('--all');
const LOG_EVERY = 25;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const maxPixels = MAX_MEGAPIXELS * 1_000_000;

const stats = {
    processed: 0,
    optimized: 0,
    skippedSmall: 0,
    skippedNotPng: 0,
    skippedMissing: 0,
    skippedNonPng: 0,
    errors: 0,
    savedBytes: 0
};

function getCardFilePath(cardId) {
    const cardIdStr = String(cardId);
    if (!/^\d+$/.test(cardIdStr)) return null;
    const subfolder = path.join(staticDir, cardIdStr.substring(0, 2));
    return path.join(subfolder, `${cardIdStr}.png`);
}

function isPng(buffer) {
    return buffer.length >= PNG_SIGNATURE.length
        && buffer.slice(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function extractTextChunks(chunks) {
    const textChunks = [];
    for (const chunk of chunks) {
        if (chunk.name === 'tEXt' || chunk.name === 'zTXt' || chunk.name === 'iTXt') {
            textChunks.push(chunk);
        }
    }
    return textChunks;
}

function reEmbedTextChunks(optimizedBuffer, textChunks) {
    if (!textChunks.length) return optimizedBuffer;

    const chunks = extractChunks(optimizedBuffer);

    // Find IEND position
    const iendIndex = chunks.findIndex(c => c.name === 'IEND');
    if (iendIndex <= 0) return optimizedBuffer;

    // Insert text chunks before IEND
    for (let i = textChunks.length - 1; i >= 0; i--) {
        chunks.splice(iendIndex, 0, textChunks[i]);
    }

    return Buffer.from(encodeChunks(chunks));
}

async function optimizeCard(cardId) {
    const pngPath = getCardFilePath(cardId);
    if (!pngPath) {
        stats.errors++;
        return;
    }

    if (!fs.existsSync(pngPath)) {
        stats.skippedMissing++;
        return;
    }

    const originalBuffer = fs.readFileSync(pngPath);

    if (!isPng(originalBuffer)) {
        stats.skippedNonPng++;
        return;
    }

    // Extract all text chunks before processing
    let textChunks;
    try {
        const chunks = extractChunks(originalBuffer);
        textChunks = extractTextChunks(chunks);
    } catch (error) {
        console.error(`[ERROR] Failed to extract chunks from card ${cardId}: ${error.message}`);
        stats.errors++;
        return;
    }

    // Get dimensions
    let metadata;
    try {
        metadata = await sharp(originalBuffer).metadata();
    } catch (error) {
        console.error(`[ERROR] Failed to read metadata for card ${cardId}: ${error.message}`);
        stats.errors++;
        return;
    }

    const { width, height } = metadata;
    const currentPixels = width * height;

    if (currentPixels <= maxPixels) {
        stats.skippedSmall++;
        return;
    }

    if (DRY_RUN) {
        const ratio = Math.sqrt(maxPixels / currentPixels);
        const newW = Math.round(width * ratio);
        const newH = Math.round(height * ratio);
        console.log(`[DRY-RUN] Card ${cardId}: ${width}x${height} (${(currentPixels / 1e6).toFixed(1)}MP) -> ${newW}x${newH}`);
        stats.optimized++;
        return;
    }

    try {
        // Calculate target dimensions preserving aspect ratio
        const ratio = Math.sqrt(maxPixels / currentPixels);
        const targetWidth = Math.round(width * ratio);
        const targetHeight = Math.round(height * ratio);

        // Resize and compress
        let optimizedBuffer = await sharp(originalBuffer)
            .resize(targetWidth, targetHeight, { fit: 'inside' })
            .png({ compressionLevel: COMPRESSION_LEVEL, adaptiveFiltering: true })
            .toBuffer();

        // Re-embed text chunks (especially the chara metadata)
        optimizedBuffer = reEmbedTextChunks(optimizedBuffer, textChunks);

        const savedBytes = originalBuffer.length - optimizedBuffer.length;

        fs.writeFileSync(pngPath, optimizedBuffer);

        stats.optimized++;
        stats.savedBytes += savedBytes;

        if (stats.optimized % LOG_EVERY === 0 || stats.optimized === 1) {
            console.log(
                `[INFO] Optimized card ${cardId}: ${width}x${height} -> ${targetWidth}x${targetHeight}, ` +
                `saved ${(savedBytes / 1024).toFixed(0)}KB`
            );
        }
    } catch (error) {
        console.error(`[ERROR] Failed to optimize card ${cardId}: ${error.message}`);
        stats.errors++;
    }
}

async function main() {
    console.log('[INFO] PNG Optimization starting...');
    console.log(`[INFO] Config: maxMP=${MAX_MEGAPIXELS}, compression=${COMPRESSION_LEVEL}, dryRun=${DRY_RUN}`);

    initDatabase();
    const db = getDatabase();

    let cardIds = [];

    if (IDS_FILTER) {
        // Queue-driven mode: process specific IDs from the service
        cardIds = IDS_FILTER.split(',').filter(Boolean).map(Number);
        console.log(`[INFO] Queue mode: processing ${cardIds.length} cards`);
    } else if (ALL_MODE) {
        // Full backlog mode: process all non-risuai cards
        const rows = db.prepare(
            "SELECT id FROM cards WHERE source != 'risuai' ORDER BY id"
        ).all();
        cardIds = rows.map(r => r.id);
        console.log(`[INFO] Full backlog mode: ${cardIds.length} non-RisuAI cards to check`);
    } else {
        // Default: drain from queue table
        const rows = db.prepare(
            'SELECT cardId FROM png_optimization_queue ORDER BY id LIMIT ?'
        ).all(BATCH_LIMIT);
        cardIds = rows.map(r => r.cardId);
        console.log(`[INFO] Queue drain mode: ${cardIds.length} cards from queue`);
    }

    if (!cardIds.length) {
        console.log('[INFO] No cards to process. Exiting.');
        process.exit(0);
    }

    for (const cardId of cardIds) {
        await optimizeCard(cardId);
        stats.processed++;

        if (stats.processed % LOG_EVERY === 0) {
            console.log(
                `[INFO] Progress: ${stats.processed}/${cardIds.length} ` +
                `(optimized=${stats.optimized}, skippedSmall=${stats.skippedSmall}, errors=${stats.errors})`
            );
        }
    }

    // Clean up queue rows if we were given specific queue row IDs
    const queueRowIds = QUEUE_ROW_IDS.split(',').filter(Boolean).map(Number);
    if (queueRowIds.length > 0) {
        try {
            const placeholders = queueRowIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM png_optimization_queue WHERE id IN (${placeholders})`).run(...queueRowIds);
            console.log(`[INFO] Cleaned ${queueRowIds.length} rows from png_optimization_queue`);
        } catch (error) {
            console.error(`[ERROR] Failed to clean queue: ${error.message}`);
        }
    } else if (!IDS_FILTER && !ALL_MODE && cardIds.length > 0) {
        // Queue drain mode without explicit row IDs — delete by cardId
        try {
            const placeholders = cardIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM png_optimization_queue WHERE cardId IN (${placeholders})`).run(...cardIds);
            console.log(`[INFO] Cleaned ${cardIds.length} processed cards from png_optimization_queue`);
        } catch (error) {
            console.error(`[ERROR] Failed to clean queue: ${error.message}`);
        }
    }

    const savedMB = (stats.savedBytes / (1024 * 1024)).toFixed(1);
    console.log(`[INFO] PNG Optimization complete:`);
    console.log(`  Processed: ${stats.processed}`);
    console.log(`  Optimized: ${stats.optimized}`);
    console.log(`  Skipped (already small): ${stats.skippedSmall}`);
    console.log(`  Skipped (missing): ${stats.skippedMissing}`);
    console.log(`  Skipped (not PNG): ${stats.skippedNonPng}`);
    console.log(`  Errors: ${stats.errors}`);
    console.log(`  Space saved: ${savedMB}MB`);

    process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
});
