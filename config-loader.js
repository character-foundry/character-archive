import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './backend/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = process.env.CHARACTER_ARCHIVE_CONFIG_FILE
    || path.join(process.env.CHARACTER_ARCHIVE_STATE_DIR || __dirname, 'config.json');

export function writeJsonAtomically(filePath, value) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        const directoryDescriptor = fs.openSync(directory, 'r');
        try {
            fs.fsyncSync(directoryDescriptor);
        } finally {
            fs.closeSync(directoryDescriptor);
        }
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporaryPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') logger.warn('Failed to remove temporary config file', unlinkError);
        }
        throw error;
    }
}

const defaultSillyTavernConfig = {
    enabled: false,
    baseUrl: '',
    importEndpoint: '/api/content/importURL',
    csrfToken: '',
    sessionCookie: '',
    extraHeaders: {}
};

const defaultMeilisearchConfig = {
    enabled: false,
    host: 'http://127.0.0.1:7700',
    apiKey: '',
    indexName: 'cards'
};

const defaultVectorSearchConfig = {
    enabled: false,
    enableChunks: true,
    cardsIndex: 'cards_vsem',
    chunksIndex: 'card_chunks',
    embedModel: 'snowflake-arctic-embed2:latest',
    embedderName: 'arctic2-1024',
    embedDimensions: 1024,
    embedBatchSize: 0,
    embeddingProvider: 'ollama',
    embeddingUrl: '',
    embeddingApiKey: '',
    ollamaUrl: 'http://127.0.0.1:11434',
    semanticRatio: 0.4,
    cardsMultiplier: 2,
    maxCardHits: 200,
    chunkLimit: 60,
    chunkWeight: 0.6,
    rrfK: 60
};

const defaultCtSyncConfig = {
    enabled: false,
    intervalMinutes: 180,
    pages: 3,
    hitsPerPage: 49,
    minTokens: 300,
    maxTokens: 900000,
    bannedTags: ['furry', 'anthro', 'beastiality', 'scat', 'guro', 'pokemon', 'vore', 'bbw', 'weight gain', 'zoophilia', 'my little pony', 'mlp'],
    excludedWarnings: ['underage'],
    bearerToken: '',
    cfClearance: '',
    session: '',
    allowedWarnings: ''
};

// Default configuration
const defaultConfig = {
    autoUpdateInterval: 60,
    autoUpdateMode: false,
    syncTagsMode: true,
    backupMode: false,
    port: 6969,
    ip: "127.0.0.1",
    venus: false,
    syncLimit: 500,
    pageLimit: 1,
    startPage: 1,
    cycle_topics: false,
    topic: "",
    excludeTopic: "",
    use_timeline: false,
    min_tokens: 0,
    apikey: "",
    chubProfileName: '',
    followedCreators: [],
    syncFollowedCreators: false,
    followedCreatorsOnly: false,
    publicBaseUrl: '',
    sillyTavern: defaultSillyTavernConfig,
    meilisearch: defaultMeilisearchConfig,
    vectorSearch: defaultVectorSearchConfig,
    ctSync: defaultCtSyncConfig
};

/**
 * Validate configuration values
 */
function validateConfig(config) {
    const errors = [];
    const warnings = [];

    // Validate port
    if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
        errors.push(`Invalid port: ${config.port} (must be between 1-65535)`);
    }

    // Validate IP address format
    if (config.ip && typeof config.ip === 'string') {
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$|^localhost$/i;
        if (!ipPattern.test(config.ip)) {
            errors.push(`Invalid IP address format: ${config.ip}`);
        }
    }

    // Validate sync limits
    if (config.syncLimit && (typeof config.syncLimit !== 'number' || config.syncLimit < 1)) {
        errors.push(`Invalid syncLimit: ${config.syncLimit} (must be a positive number)`);
    }

    if (config.pageLimit && (typeof config.pageLimit !== 'number' || config.pageLimit < 1)) {
        errors.push(`Invalid pageLimit: ${config.pageLimit} (must be a positive number)`);
    }

    if (config.startPage && (typeof config.startPage !== 'number' || config.startPage < 1)) {
        errors.push(`Invalid startPage: ${config.startPage} (must be a positive number)`);
    }

    // Validate min_tokens
    if (config.min_tokens && (typeof config.min_tokens !== 'number' || config.min_tokens < 0)) {
        errors.push(`Invalid min_tokens: ${config.min_tokens} (must be >= 0)`);
    }

    // Validate SillyTavern config
    if (config.sillyTavern?.enabled) {
        if (!config.sillyTavern.baseUrl || typeof config.sillyTavern.baseUrl !== 'string') {
            errors.push('SillyTavern enabled but baseUrl not configured');
        } else if (!config.sillyTavern.baseUrl.startsWith('http://') && !config.sillyTavern.baseUrl.startsWith('https://')) {
            errors.push(`Invalid SillyTavern baseUrl: ${config.sillyTavern.baseUrl} (must start with http:// or https://)`);
        }
    }

    // Validate Meilisearch config
    if (config.meilisearch?.enabled) {
        if (!config.meilisearch.host || typeof config.meilisearch.host !== 'string') {
            errors.push('Meilisearch enabled but host not configured');
        } else if (!config.meilisearch.host.startsWith('http://') && !config.meilisearch.host.startsWith('https://')) {
            errors.push(`Invalid Meilisearch host: ${config.meilisearch.host} (must start with http:// or https://)`);
        }
        if (!config.meilisearch.indexName || typeof config.meilisearch.indexName !== 'string') {
            errors.push('Meilisearch enabled but indexName not configured');
        }
    }

    // Validate Vector Search config
    if (config.vectorSearch?.enabled) {
        const provider = String(config.vectorSearch.embeddingProvider || 'ollama').toLowerCase();
        const embeddingUrl = config.vectorSearch.embeddingUrl || config.vectorSearch.ollamaUrl;
        if (!embeddingUrl || typeof embeddingUrl !== 'string') {
            errors.push(`Vector search enabled but no ${provider} embedding URL is configured`);
        } else if (!embeddingUrl.startsWith('http://') && !embeddingUrl.startsWith('https://')) {
            errors.push(`Invalid embedding URL: ${embeddingUrl} (must start with http:// or https://)`);
        }

        if (config.vectorSearch.semanticRatio && (config.vectorSearch.semanticRatio < 0 || config.vectorSearch.semanticRatio > 1)) {
            errors.push(`Invalid semanticRatio: ${config.vectorSearch.semanticRatio} (must be between 0-1)`);
        }

        if (config.vectorSearch.embedDimensions && (typeof config.vectorSearch.embedDimensions !== 'number' || config.vectorSearch.embedDimensions < 1)) {
            errors.push(`Invalid embedDimensions: ${config.vectorSearch.embedDimensions} (must be a positive number)`);
        }
    }

    // Validate CT Sync config
    if (config.ctSync?.enabled) {
        if (config.ctSync.intervalMinutes && (typeof config.ctSync.intervalMinutes !== 'number' || config.ctSync.intervalMinutes < 1)) {
            errors.push(`Invalid ctSync.intervalMinutes: ${config.ctSync.intervalMinutes} (must be a positive number)`);
        }

        if (config.ctSync.minTokens && (typeof config.ctSync.minTokens !== 'number' || config.ctSync.minTokens < 0)) {
            errors.push(`Invalid ctSync.minTokens: ${config.ctSync.minTokens} (must be >= 0)`);
        }

        if (config.ctSync.maxTokens && (typeof config.ctSync.maxTokens !== 'number' || config.ctSync.maxTokens < config.ctSync.minTokens)) {
            errors.push(`Invalid ctSync.maxTokens: ${config.ctSync.maxTokens} (must be >= minTokens)`);
        }

        if (!config.ctSync.bearerToken && !config.ctSync.session) {
            warnings.push('CT sync enabled but no authentication configured (bearerToken or session)');
        }
    }

    // Validate followedCreators array
    if (config.followedCreators && !Array.isArray(config.followedCreators)) {
        errors.push('followedCreators must be an array');
    }

    // Log results
    if (errors.length > 0) {
        logger.error('Config validation failed', null, { errors });
        errors.forEach(err => logger.error(`  - ${err}`));
        throw new Error(`Config validation failed: ${errors.join('; ')}`);
    }

    if (warnings.length > 0) {
        logger.warn('Config validation warnings', { warnings });
        warnings.forEach(warn => logger.warn(`  - ${warn}`));
    }

    return true;
}

function mergeConfig(config = {}) {
    return {
        ...defaultConfig,
        ...config,
        sillyTavern: { ...defaultSillyTavernConfig, ...(config.sillyTavern || {}) },
        meilisearch: { ...defaultMeilisearchConfig, ...(config.meilisearch || {}) },
        ctSync: { ...defaultCtSyncConfig, ...(config.ctSync || {}) },
        vectorSearch: { ...defaultVectorSearchConfig, ...(config.vectorSearch || {}) }
    };
}

function applyEnvironmentOverrides(config) {
    if (process.env.MEILI_HOST) config.meilisearch.host = process.env.MEILI_HOST;
    if (process.env.MEILI_KEY) config.meilisearch.apiKey = process.env.MEILI_KEY;
    if (process.env.EMBEDDING_PROVIDER) config.vectorSearch.embeddingProvider = process.env.EMBEDDING_PROVIDER;
    if (process.env.EMBEDDING_URL) config.vectorSearch.embeddingUrl = process.env.EMBEDDING_URL;
    if (process.env.EMBEDDING_API_KEY) config.vectorSearch.embeddingApiKey = process.env.EMBEDDING_API_KEY;
    return config;
}

/**
 * Load configuration from file or create default
 */
export function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        writeJsonAtomically(CONFIG_FILE, defaultConfig);
        logger.info('Created default config.json');
        const createdConfig = applyEnvironmentOverrides(mergeConfig());
        validateConfig(createdConfig);
        return createdConfig;
    }

    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        const config = JSON.parse(data);

        // Merge with defaults to add any missing keys
        const mergedConfig = applyEnvironmentOverrides(mergeConfig(config));

        // Normalize followed creators
        if (typeof mergedConfig.followedCreators === 'string') {
            mergedConfig.followedCreators = mergedConfig.followedCreators
                .split(',')
                .map(c => c.trim())
                .filter(c => c);
        }

        // Validate the merged configuration
        validateConfig(mergedConfig);

        return mergedConfig;
    } catch (error) {
        logger.error('Failed to load config', error);
        throw error;
    }
}

/**
 * Save configuration to file
 */
export function saveConfig(config) {
    try {
        // Normalize followed creators before saving
        if (Array.isArray(config.followedCreators)) {
            config.followedCreators = config.followedCreators.filter(c => c && c.trim());
        }
        if (typeof config.chubProfileName === 'string') {
            config.chubProfileName = config.chubProfileName.trim();
        }

        const mergedSilly = {
            ...defaultSillyTavernConfig,
            ...(config.sillyTavern || {})
        };
        config.sillyTavern = mergedSilly;

        const mergedMeili = {
            ...defaultMeilisearchConfig,
            ...(config.meilisearch || {})
        };
        config.meilisearch = mergedMeili;

        const mergedCtSync = {
            ...defaultCtSyncConfig,
            ...(config.ctSync || {})
        };
        config.ctSync = mergedCtSync;

        const mergedVectorSearch = {
            ...defaultVectorSearchConfig,
            ...(config.vectorSearch || {})
        };
        config.vectorSearch = mergedVectorSearch;

        // Validate before saving
        validateConfig(config);

        writeJsonAtomically(CONFIG_FILE, config);
        logger.info('Configuration saved');
        return true;
    } catch (error) {
        logger.error('Failed to save config', error);
        throw error;
    }
}

export default {
    loadConfig,
    saveConfig
};
