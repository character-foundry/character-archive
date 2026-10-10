
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cardController } from '../controllers/CardController.js';
import { assetController } from '../controllers/AssetController.js';

const router = express.Router();

// Stricter rate limiter for refresh operations - prevents abuse
const refreshLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 20, // 20 refresh operations per minute
    message: { error: 'Refresh rate limit exceeded. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
});

// Define card routes
router.get('/', cardController.listCards);
router.get('/favorite-status', cardController.favoriteStatus);
router.get('/:cardId/png-info', cardController.getPngInfo);
router.get('/:cardId/metadata', cardController.getCardMetadata);
router.post('/:cardId/refresh', refreshLimiter, cardController.refreshCard);
router.delete('/:cardId', cardController.deleteCard);
router.post('/bulk-delete', cardController.bulkDelete);
router.post('/:cardId/favorite', cardController.toggleFavorite);
router.post('/:cardId/language', cardController.setLanguage);
router.post('/:cardId/tags', cardController.editTags);
router.get('/:cardId/export', cardController.exportCard);
router.post('/:cardId/push', cardController.pushToSillyTavern);
router.post('/:cardId/push-to-architect', cardController.pushToArchitect);
router.post('/:cardId/push-to-lumiverse', cardController.pushToLumiverse);

// Asset routes
router.get('/:cardId/assets/scan', assetController.scanAssets);
router.post('/:cardId/assets/cache', assetController.cacheAssets);
router.get('/:cardId/assets', assetController.getAssets);
router.get('/:cardId/gallery', assetController.getGallery);
router.delete('/:cardId/assets', assetController.clearAssets);

export default router;
