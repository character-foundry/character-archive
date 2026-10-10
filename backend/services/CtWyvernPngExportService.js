import fs from 'fs';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { getDatabase } from '../database.js';
import { getCardFilePaths } from '../utils/card-utils.js';
import { createCardPng } from '../utils/png-utils.js';

/** Export CT/Wyvern cards, including old cached avatars whose definition is only in the sidecar. */
export async function exportCtWyvernPng(cardId, useLocal = false) {
    const db = getDatabase();
    const row = db.prepare('SELECT source FROM cards WHERE id = ?').get(cardId);
    if (!['ct', 'wyvern'].includes(row?.source)) return null;

    const { pngPath, jsonPath } = getCardFilePaths(cardId);
    if (!fs.existsSync(pngPath)) return null;
    const image = fs.readFileSync(pngPath);
    const metadata = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
    const definition = metadata?.definition || parseCard(image, `${cardId}.png`).card;

    const assets = useLocal
        ? db.prepare('SELECT originalUrl, localPath FROM cached_assets WHERE cardId = ?').all(cardId)
        : [];
    // Rewrite the definition, including greetings, lorebooks and extensions, without changing the cache.
    const rewritten = JSON.parse(JSON.stringify(definition), (_key, value) => {
        if (typeof value !== 'string') return value;
        for (const asset of assets) {
            value = value.split(asset.originalUrl).join(`/static/${asset.localPath}`);
        }
        return value;
    });
    return createCardPng(image, rewritten);
}
