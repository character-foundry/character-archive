/**
 * CardMetadataService - Handles card metadata operations
 *
 * Extracted from CardController to provide:
 * - PNG spec extraction
 * - JSON metadata loading
 * - Feature flag synchronization
 */

import fs from 'fs';
import { getDatabase } from '../database.js';
import { readCardPngSpec, getCardFilePaths } from '../utils/card-utils.js';
import { deriveFeatures } from '@character-foundry/schemas';
import { logger } from '../utils/logger.js';

const log = logger.scoped('CARD-META');

/**
 * Sync feature flags from metadata and PNG spec to database
 */
export async function syncFeatureFlagsFromMetadata(cardId, metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return;
    }

    const database = getDatabase();
    const spec = readCardPngSpec(cardId);
    const specFlags = spec ? deriveFeatures(spec) : {};

    const pickBoolean = (key) => {
        if (typeof metadata[key] !== 'undefined') {
            return metadata[key] ? 1 : 0;
        }
        if (typeof specFlags[key] !== 'undefined') {
            return specFlags[key] ? 1 : 0;
        }
        return 0;
    };

    try {
        database.prepare(
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
            pickBoolean('hasAlternateGreetings'),
            pickBoolean('hasLorebook'),
            pickBoolean('hasEmbeddedLorebook'),
            pickBoolean('hasLinkedLorebook'),
            pickBoolean('hasExampleDialogues'),
            pickBoolean('hasSystemPrompt'),
            pickBoolean('hasGallery'),
            pickBoolean('hasEmbeddedImages'),
            pickBoolean('hasExpressions'),
            cardId
        );
    } catch (error) {
        log.warn(`Failed to sync metadata flags for card ${cardId}`, error);
    }

    // Also update the metadata object in place
    Object.assign(metadata, {
        hasAlternateGreetings: Boolean(pickBoolean('hasAlternateGreetings')),
        hasLorebook: Boolean(pickBoolean('hasLorebook')),
        hasEmbeddedLorebook: Boolean(pickBoolean('hasEmbeddedLorebook')),
        hasLinkedLorebook: Boolean(pickBoolean('hasLinkedLorebook')),
        hasExampleDialogues: Boolean(pickBoolean('hasExampleDialogues')),
        hasSystemPrompt: Boolean(pickBoolean('hasSystemPrompt')),
        hasGallery: Boolean(pickBoolean('hasGallery')),
        hasEmbeddedImages: Boolean(pickBoolean('hasEmbeddedImages')),
        hasExpressions: Boolean(pickBoolean('hasExpressions'))
    });
}

/**
 * Get PNG info (embedded spec) for a card
 */
export function getPngInfo(cardId) {
    const spec = readCardPngSpec(cardId);
    if (!spec) {
        return null;
    }

    // Try to attach tagline from JSON metadata
    const { jsonPath } = getCardFilePaths(cardId);
    if (fs.existsSync(jsonPath)) {
        try {
            const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            spec.Tagline = metadata.tagline;
        } catch (error) {
            log.warn('Failed to attach tagline to PNG info', error);
        }
    }

    return spec;
}

/**
 * Get card metadata from JSON file
 */
export async function getCardMetadata(cardId) {
    const { jsonPath } = getCardFilePaths(cardId);

    if (!fs.existsSync(jsonPath)) {
        return null;
    }

    const metadataRaw = await fs.promises.readFile(jsonPath, 'utf8');
    const metadata = JSON.parse(metadataRaw);

    return metadata;
}

/**
 * Update card metadata JSON file
 */
export async function updateCardMetadata(cardId, updates) {
    const { jsonPath } = getCardFilePaths(cardId);

    if (!fs.existsSync(jsonPath)) {
        throw new Error('Metadata file not found');
    }

    const metadataRaw = await fs.promises.readFile(jsonPath, 'utf8');
    const metadata = JSON.parse(metadataRaw);

    Object.assign(metadata, updates);

    await fs.promises.writeFile(jsonPath, JSON.stringify(metadata, null, 4));

    return metadata;
}

/**
 * Check if card files exist
 */
export function cardFilesExist(cardId) {
    const { pngPath, jsonPath, charxPath } = getCardFilePaths(cardId);

    return {
        png: fs.existsSync(pngPath),
        json: fs.existsSync(jsonPath),
        charx: fs.existsSync(charxPath),
        any: fs.existsSync(pngPath) || fs.existsSync(charxPath)
    };
}

export default {
    syncFeatureFlagsFromMetadata,
    getPngInfo,
    getCardMetadata,
    updateCardMetadata,
    cardFilesExist
};
