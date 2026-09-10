import fs from 'fs';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import textChunk from 'png-chunk-text';
import { logger } from './logger.js';

const log = logger.scoped('PNG-UTIL');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Embed the current definition without retaining stale v2/v3 card chunks. */
export function embedCardDefinition(pngBuffer, definition) {
    const cardKeys = new Set(['chara', 'ccv3', 'chara_card_v3']);
    const chunks = extractChunks(pngBuffer).filter(chunk => {
        if (!['tEXt', 'zTXt', 'iTXt'].includes(chunk.name)) return true;
        const data = Buffer.from(chunk.data);
        const separator = data.indexOf(0);
        return !cardKeys.has(data.subarray(0, separator).toString('latin1'));
    });
    const endIndex = chunks.findIndex(chunk => chunk.name === 'IEND');
    if (endIndex < 1) throw new Error('Cannot embed character data in an incomplete PNG');
    const payload = Buffer.from(JSON.stringify(definition), 'utf8').toString('base64');
    chunks.splice(endIndex, 0, textChunk.encode('chara', payload));
    return Buffer.from(encodeChunks(chunks));
}

/**
 * Extract dimensions directly from PNG IHDR chunk
 * No sharp required - just read the chunk data
 */
function extractPngDimensions(buffer) {
    try {
        const chunks = extractChunks(buffer);
        const ihdr = chunks.find(c => c.name === 'IHDR');

        if (!ihdr || ihdr.data.length < 8) {
            return { width: 0, height: 0 };
        }

        // Convert Uint8Array to Buffer if needed
        const data = Buffer.isBuffer(ihdr.data) ? ihdr.data : Buffer.from(ihdr.data);

        // IHDR format: width(4 bytes) height(4 bytes) bitDepth(1) colorType(1) ...
        const width = data.readUInt32BE(0);
        const height = data.readUInt32BE(4);

        return { width, height };
    } catch (error) {
        log.warn('Failed to extract PNG dimensions', error);
        return { width: 0, height: 0 };
    }
}

export async function analyzePng(buffer) {
    if (!buffer || buffer.length < PNG_SIGNATURE.length) {
        return { ok: false, reason: 'buffer_too_small' };
    }
    if (!buffer.slice(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return { ok: false, reason: 'invalid_signature' };
    }

    // Extract dimensions from IHDR chunk (no sharp needed!)
    const { width, height } = extractPngDimensions(buffer);
    const sizeKB = buffer.length / 1024;

    return {
        ok: true,
        width,
        height,
        sizeKB,
        // We don't have brightness info without pixel analysis, but we don't need it
        // Fuzz detection uses dimensions + size, not brightness
        avgBrightness: 128  // Neutral default
    };
}

export async function analyzeExistingPng(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const buffer = fs.readFileSync(filePath);
    return { buffer, info: await analyzePng(buffer) };
}

/**
 * Check if PNG matches known fuzz/placeholder patterns
 * Returns { isFuzz: boolean, reason: string }
 *
 * NOTE: This should ONLY be called for EXISTING images being compared to new downloads.
 * NEW cards should NEVER be fuzz-checked - we accept whatever the creator uploaded.
 */
export function detectFuzzPattern(info) {
    // Invalid/corrupt PNGs are not "fuzz" - they're just broken and should be retried
    if (!info || !info.ok) {
        return { isFuzz: false, reason: 'invalid_png' };
    }

    // Known "fuzz" signatures from Chub
    // 240x240 is the standard Chub fuzz placeholder
    if (info.width === 240 && info.height === 240 && info.sizeKB < 150) {
        return { isFuzz: true, reason: 'chub_240x240_placeholder' };
    }

    // Extremely tiny canvases (likely fuzz or corruption)
    if (info.width <= 32 || info.height <= 32) {
        return { isFuzz: true, reason: 'tiny_dimensions' };
    }

    // Very small file size indicates fuzz or corruption
    if (info.sizeKB < 2) {
        return { isFuzz: true, reason: 'too_small' };
    }

    return { isFuzz: false, reason: null };
}

/**
 * Determine if a downloaded PNG should be rejected in favor of existing image
 * Returns true if the new PNG should be rejected
 *
 * IMPORTANT: This should only reject when we have a GOOD existing image and the new one is WORSE.
 * For NEW cards (no previousInfo), we should NEVER reject - accept whatever was downloaded.
 */
export function isPngSuspect(info, previousInfo, options = {}) {
    const { skipFuzzWithoutPrevious = false } = options;

    // NEW CARD (no previous image) - ALWAYS accept, never reject
    // Even if the PNG analysis failed, we have no fallback, so accept it
    if (!previousInfo || !previousInfo.ok) {
        return false;
    }

    // Invalid PNG with existing fallback - should be rejected
    if (!info || !info.ok) {
        return true;
    }

    // EXISTING CARD - check if new image is worse than existing

    // Check if new image is fuzzed (placeholder)
    const newIsFuzzed = detectFuzzPattern(info).isFuzz;
    const existingIsFuzzed = detectFuzzPattern(previousInfo).isFuzz;

    // If existing is GOOD and new is FUZZED, reject new (keep existing)
    if (!existingIsFuzzed && newIsFuzzed) {
        console.log(`[INFO] Rejecting fuzzed update (existing image is good)`);
        return true;
    }

    // If existing is FUZZED and new is GOOD, accept new (upgrade from fuzz)
    if (existingIsFuzzed && !newIsFuzzed) {
        console.log(`[INFO] Accepting update (upgrading from fuzzed image)`);
        return false;
    }

    // Check for dramatic size reduction (85%+ smaller) - likely corruption or downgrade
    if (info.sizeKB < previousInfo.sizeKB * 0.15) {
        console.log(`[INFO] Rejecting dramatic size reduction: ${previousInfo.sizeKB.toFixed(1)}KB → ${info.sizeKB.toFixed(1)}KB`);
        return true;
    }

    // Otherwise accept the update
    return false;
}
