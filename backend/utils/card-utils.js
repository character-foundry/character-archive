import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';
import { countImages } from '@character-foundry/character-foundry/image-utils';

const log = logger.scoped('CARD-UTIL');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const STATIC_DIR = path.join(__dirname, '../../static');

export function getCardFilePaths(cardId) {
    const cardIdStr = String(cardId);

    // Security: Validate cardId is numeric only to prevent path traversal
    if (!/^\d+$/.test(cardIdStr)) {
        throw new Error(`Invalid card ID: ${cardIdStr}`);
    }

    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
    return {
        subfolder,
        jsonPath: path.join(subfolder, `${cardIdStr}.json`),
        pngPath: path.join(subfolder, `${cardIdStr}.png`),
        fullPngPath: path.join(subfolder, `${cardIdStr}.card.png`), // RisuAI full PNG with assets
        charxPath: path.join(subfolder, `${cardIdStr}.charx`)
    };
}

export function readCardPngSpec(cardId) {
    const { pngPath, fullPngPath, charxPath, jsonPath } = getCardFilePaths(cardId);

    // Try full PNG first (RisuAI cards with embedded assets)
    if (fs.existsSync(fullPngPath)) {
        try {
            const buffer = fs.readFileSync(fullPngPath);
            const result = parseCard(buffer, path.basename(fullPngPath));
            if (result && result.card) {
                return result.card;
            }
        } catch (error) {
            log.debug(`Full PNG parse failed for ${cardId}, trying alternatives`);
        }
    }

    // Try regular PNG (Chub cards, or fallback)
    if (fs.existsSync(pngPath)) {
        try {
            const buffer = fs.readFileSync(pngPath);
            const result = parseCard(buffer, path.basename(pngPath));
            if (result && result.card) {
                return result.card;
            }
        } catch (error) {
            // PNG parse failed (might be JPEG thumbnail), try other formats
            log.debug(`PNG parse failed for ${cardId}, trying alternatives`);
        }
    }

    // Try CharX (RisuAI cards)
    if (fs.existsSync(charxPath)) {
        try {
            const buffer = fs.readFileSync(charxPath);
            const result = parseCard(buffer, path.basename(charxPath));
            if (result && result.card) {
                return result.card;
            }
        } catch (error) {
            log.debug(`CharX parse failed for ${cardId}`);
        }
    }

    // Fall back to sidecar JSON (RisuAI cards with JPEG thumbnails)
    if (fs.existsSync(jsonPath)) {
        try {
            const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            // If JSON has definition field, return it as card spec
            if (jsonData.definition) {
                return jsonData.definition;
            }
            // Otherwise return the whole JSON as a card-like object
            return jsonData;
        } catch (error) {
            log.debug(`JSON parse failed for ${cardId}`);
        }
    }

    log.warn(`Failed to parse card ${cardId} - no valid format found`);
    return null;
}

// Old hasEmbeddedImages() and deriveFeatureFlagsFromSpec() functions removed.
// Use countImages() from @character-foundry/character-foundry/image-utils and deriveFeatures() from @character-foundry/character-foundry/schemas instead.
