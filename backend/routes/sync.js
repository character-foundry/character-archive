
import express from 'express';
import { syncController } from '../controllers/SyncController.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiters (could be shared in a middleware file)
const syncLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minute window
    max: 5, // 5 sync operations per 5 minutes
    message: 'Sync rate limit exceeded. Please wait before starting another sync.',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
});

router.post('/runs', syncLimiter, syncController.createRun);
router.get('/runs/:id', syncController.getRun);
router.post('/runs/:id/cancel', syncController.cancelRun);

// Legacy SSE wrappers enqueue durable runs so existing clients keep working.
router.get('/', syncLimiter, syncController.syncCards);
router.get('/cards', syncLimiter, syncController.syncChub);
router.get('/ct', syncLimiter, syncController.syncCharacterTavern);
router.get('/wyvern', syncLimiter, syncController.syncWyvern);
router.get('/risuai', syncLimiter, syncController.syncRisuAi);
router.post('/favorites', syncController.syncFavoritesToChub);
router.get('/chub/follows', syncController.getChubFollows);
router.get('/chub/blocked', syncController.getChubBlockedUsers);

// Sync status and cancel endpoints
router.get('/status', syncController.getStatus);
router.post('/cancel', syncController.cancelAll);

export default router;
