#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getDatabase, upsertCard } from '../backend/database.js';
import { deriveFeatures } from '@character-foundry/character-foundry/schemas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, '..', 'static');

async function updateAllMetadata() {
    console.log('[INFO] Starting metadata update for all cards...');
    await initDatabase();
    
    const db = getDatabase();
    const allCards = db.prepare('SELECT id FROM cards').all();
    
    let updated = 0;
    let errors = 0;
    
    for (const row of allCards) {
        const cardId = String(row.id);
        const subfolder = path.join(STATIC_DIR, cardId.substring(0, 2));
        const jsonPath = path.join(subfolder, `${cardId}.json`);
        
        if (!fs.existsSync(jsonPath)) {
            console.warn(`[WARNING] No JSON found for card ${cardId}, skipping`);
            errors++;
            continue;
        }
        
        try {
            const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

            // Derive all feature flags using canonical function
            const features = deriveFeatures(metadata);

            // Check for gallery assets in database cache (special case)
            let hasGallery = features.hasGallery || false;
            if (!hasGallery) {
                try {
                    const cachedGallery = db.prepare(
                        'SELECT COUNT(*) as count FROM cached_assets WHERE cardId = ? AND assetType = ?'
                    ).get(cardId, 'gallery');
                    if (cachedGallery?.count > 0) {
                        hasGallery = true;
                    }
                } catch (galleryError) {
                    console.warn(`[WARNING] Failed to inspect cached gallery for ${cardId}:`, galleryError.message);
                }
            }

            // Update metadata flags
            metadata.hasAlternateGreetings = features.hasAlternateGreetings || false;
            metadata.hasEmbeddedLorebook = features.hasEmbeddedLorebook || false;
            metadata.hasLinkedLorebook = features.hasLinkedLorebook || false;
            metadata.hasLorebook = features.hasLorebook || false;
            metadata.hasExampleDialogues = features.hasExampleDialogues || false;
            metadata.hasSystemPrompt = features.hasSystemPrompt || false;
            metadata.hasGallery = hasGallery;
            
            // Save updated metadata
            fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 4));
            await upsertCard(metadata);
            
            updated++;
            if (updated % 100 === 0) {
                console.log(`[INFO] Updated ${updated}/${allCards.length} cards...`);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to update card ${cardId}:`, error.message);
            errors++;
        }
    }
    
    console.log(`[INFO] Metadata update complete. Updated: ${updated}, Errors: ${errors}`);
    process.exit(0);
}

updateAllMetadata().catch(err => {
    console.error('[ERROR] Update failed:', err);
    process.exit(1);
});

