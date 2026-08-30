
import express from 'express';
import { configController } from '../controllers/ConfigController.js';

const router = express.Router();

router.get('/', configController.getConfig);
router.post('/', configController.setConfig);

export default router;
