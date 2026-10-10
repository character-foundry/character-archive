
import { testDirectConnection } from '../services/DirectConnectionsService.js';
import express from 'express';
import { configController } from '../controllers/ConfigController.js';

const router = express.Router();

router.post('/test-connection', async (req, res) => {
    const { target, settings } = req.body || {};
    if (!['architect', 'lumiverse'].includes(target) || !settings) return res.status(400).json({ error: 'Invalid connection' });
    try { res.json(await testDirectConnection(target, settings)); }
    catch (error) { res.status(502).json({ error: error.response?.status === 401 ? 'Session expired or missing. Update the session token or cookie.' : error.message }); }
});
router.get('/',  configController.getConfig);
router.post('/', configController.setConfig);

export default router;
