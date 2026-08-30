import express from 'express';
import { vectorController } from '../controllers/VectorController.js';

const router = express.Router();
router.get('/status', vectorController.status);
router.post('/reconcile', vectorController.reconcile);

export default router;
