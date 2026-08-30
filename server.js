import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { appConfig as config } from './backend/services/ConfigState.js';
import { schedulerService } from './backend/services/SchedulerService.js';
import configRouter from './backend/routes/config.js';
import { initDatabase } from './backend/database.js';
import { configureSearchIndex, configureVectorSearch, ensureVectorEmbedders } from './backend/services/search-index.js';

import cardRouter from './backend/routes/cards.js';
import syncRouter from './backend/routes/sync.js';
import adminRouter from './backend/routes/admin.js';
import tagRouter from './backend/routes/tags.js';
import federationRouter from './backend/routes/federation.js';
import metricsRouter from './backend/routes/metrics.js';
import vectorRouter from './backend/routes/vector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Initialize
const app = express();


// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable for inline scripts
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security: IP and Domain Whitelist
// Parse additional allowed IPs from environment (comma-separated, supports CIDR notation)
const ALLOWED_IPS = [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
    ...(process.env.ALLOWED_IPS?.split(',').map(ip => ip.trim()).filter(Boolean) || [])
];
const ALLOWED_DOMAINS = [/\.local\.vega\.nyc$/, /^localhost$/, /^127\.0\.0\.1$/];

// Check if IP matches a CIDR range (simple prefix-based for Docker networks)
function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    if (!bits) return ip === range;
    // Simple prefix matching for common Docker networks (172.x, 10.x, 192.168.x)
    const maskBits = parseInt(bits, 10);
    const octetsToMatch = Math.floor(maskBits / 8);
    const ipParts = ip.split('.');
    const rangeParts = range.split('.');
    if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
    for (let i = 0; i < octetsToMatch; i++) {
        if (ipParts[i] !== rangeParts[i]) return false;
    }
    return true;
}

// Check if client IP is allowed
function isIpAllowed(clientIp) {
    const normalizedIp = clientIp?.replace('::ffff:', '') || '';
    return ALLOWED_IPS.some(allowed => {
        const normalizedAllowed = allowed.replace('::ffff:', '');
        // Exact match
        if (normalizedIp === normalizedAllowed || clientIp === allowed) return true;
        // CIDR range match (e.g., 172.16.0.0/12)
        if (allowed.includes('/') && isIpInCidr(normalizedIp, allowed)) return true;
        // Prefix match (e.g., "172." matches all 172.x.x.x)
        if (allowed.endsWith('.') && normalizedIp.startsWith(allowed)) return true;
        return false;
    });
}

app.use((req, res, next) => {
    // 1. IP Whitelist
    if (!isIpAllowed(req.ip)) {
        console.warn(`[SECURITY] Blocked request from unauthorized IP: ${req.ip}`);
        return res.status(403).send('Forbidden IP');
    }
    next();
});

// CORS for federation
app.use((req, res, next) => {
    const origin = req.headers.origin;
    let allowed = false;
    
    if (!origin) {
        // Non-browser requests or same-origin
        allowed = true;
    } else {
        try {
            const hostname = new URL(origin).hostname;
            if (ALLOWED_DOMAINS.some(pattern => pattern.test(hostname))) {
                allowed = true;
                res.header('Access-Control-Allow-Origin', origin);
                res.header('Access-Control-Allow-Credentials', 'true');
            }
        } catch (e) {
            // Invalid origin
        }
    }

    if (allowed) {
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(allowed ? 200 : 403);
    }
    next();
});

// Rate limiting middleware
// General API rate limiter - protects against abuse and accidental loops
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 100, // 100 requests per minute per IP
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    // Skip rate limiting for localhost in development
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
});


// Note: Refresh rate limiter moved to backend/routes/cards.js (applied to specific route)

// Apply general rate limiter to all API routes
app.use('/api/', apiLimiter);

// Static files
app.use('/static', express.static(process.env.CHARACTER_ARCHIVE_STATIC_DIR || path.join(__dirname, 'static')));

// Initialize database
initDatabase();
configureSearchIndex(config.meilisearch);
configureVectorSearch(config.vectorSearch || {});
ensureVectorEmbedders().catch(error => {
    console.warn('[WARN] Failed to ensure vector embedders on startup:', error?.message || error);
});
























app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Character Archive API is running',
        documentation: 'Use the /api endpoints to interact with the service.'
    });
});
app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (req, res) => {
    try {
        const row = initDatabase({ skipTagRebuild: true, skipTokenBackfill: true, skipSchemaMigrations: true })
            .prepare('SELECT 1 AS ready')
            .get();
        res.json({ status: row?.ready === 1 ? 'ready' : 'not-ready' });
    } catch (error) {
        res.status(503).json({ status: 'not-ready', error: error.message });
    }
});

app.use('/api/cards', cardRouter);
app.use('/api/sync', syncRouter);
app.use('/api/vector', vectorRouter);

app.get('/get_png_info/:cardId', (req, res) => res.redirect(301, `/api/cards/${req.params.cardId}/png-info`));
app.get('/get_card_metadata/:cardId', (req, res) => res.redirect(301, `/api/cards/${req.params.cardId}/metadata`));



app.post('/toggle_favorite/:cardId', (req, res) => res.redirect(307, `/api/cards/${req.params.cardId}/favorite`));



// Legacy/Root redirects for sync
app.get('/sync', (req, res) => res.redirect(307, '/api/sync/cards'));
app.get('/sync/ct', (req, res) => res.redirect(307, '/api/sync/ct'));
app.post('/api/favorites/sync-chub', (req, res) => res.redirect(307, '/api/sync/favorites'));

app.use('/api/admin', adminRouter);

app.post('/bulk_delete_cards', (req, res) => res.redirect(307, '/api/cards/bulk-delete'));
app.delete('/delete_card/:cardId', (req, res) => res.redirect(307, `/api/cards/${req.params.cardId}`));

app.use('/api/config', configRouter);
app.get('/get_config', (req, res) => res.redirect(307, '/api/config'));
app.post('/set_config', (req, res) => res.redirect(307, '/api/config'));

app.get('/api/chub/follows', (req, res) => res.redirect(307, '/api/sync/chub/follows'));

app.use('/api/tags', tagRouter);
app.use('/api/federation', federationRouter);
app.use('/api/metrics', metricsRouter);

app.get('/reroll-tags', (req, res) => res.redirect(307, '/api/tags/random'));
app.get('/api/tag-aliases', (req, res) => res.redirect(307, '/api/tags/aliases'));

app.post('/cards/:cardId/set-language', (req, res) => res.redirect(307, `/api/cards/${req.params.cardId}/language`));

app.post('/edit_tags/:cardId', (req, res) => res.redirect(307, `/api/cards/${req.params.cardId}/tags`));





// Start server
const PORT = Number(process.env.PORT || config.port || 6969);
const HOST = process.env.HOST || config.ip || '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`[INFO] Server running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
        console.log(`[INFO] Server is accessible from your LAN`);
        console.log(`[INFO] Use your machine's IP address to access from other devices`);
    }
    console.log(`[INFO] Database initialized`);
    console.log(`[INFO] Press Ctrl+C to stop`);
    
    // Source scheduling and sync execution belong to the durable archive-worker.
    schedulerService.startSearchIndexScheduler();
    schedulerService.startMetricsSnapshotScheduler();
    schedulerService.startWalCheckpointScheduler();
});

export default app;
export const startAutoUpdate = () => schedulerService.startAutoUpdate();
