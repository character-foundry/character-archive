/**
 * Structured logging module for consistent error logging across the application
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.debug('Debug message', { userId: 123 });
 *   logger.info('Info message');
 *   logger.warn('Warning message', { context: 'data' });
 *   logger.error('Error occurred', error, { cardId: 456 });
 */

// Log levels
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// Current log level (can be set via environment variable)
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
const SENSITIVE_LOG_KEY = /(?:^|[-_])(authorization|cookie|api[-_]?key|token|password|secret|session|samwise|bearer|clearance)(?:$|[-_])/i;

/**
 * Format timestamp for logs
 */
function getTimestamp() {
    return new Date().toISOString();
}

export function sanitizeLogValue(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (value instanceof Error) {
        return Object.fromEntries([
            ['name', value.name],
            ['message', value.message],
            ['code', value.code],
            ['status', value.status]
        ].filter(([, entry]) => entry !== undefined));
    }
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (depth >= 8) return '[MAX_DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(entry => sanitizeLogValue(entry, seen, depth + 1));
    }

    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_LOG_KEY.test(key) ? '[REDACTED]' : sanitizeLogValue(entry, seen, depth + 1)
    ]));
}

/**
 * Format metadata object for logging
 */
function formatMeta(meta) {
    if (!meta || Object.keys(meta).length === 0) return '';
    try {
        return ' ' + JSON.stringify(sanitizeLogValue(meta));
    } catch (error) {
        return ' [metadata serialization failed]';
    }
}

/**
 * Format error object for logging
 */
function formatError(error) {
    if (!error) return '';
    if (typeof error === 'string') return ` ${error}`;
    if (error instanceof Error) {
        return ` ${error.message}${error.stack ? '\n' + error.stack : ''}`;
    }
    return ` ${String(error)}`;
}

/**
 * Debug level logging - detailed information for debugging
 */
function debug(message, meta = {}) {
    if (CURRENT_LOG_LEVEL > LOG_LEVELS.DEBUG) return;
    console.log(`[DEBUG] ${message}${formatMeta(meta)}`);
}

/**
 * Info level logging - general informational messages
 */
function info(message, meta = {}) {
    if (CURRENT_LOG_LEVEL > LOG_LEVELS.INFO) return;
    console.log(`[INFO] ${message}${formatMeta(meta)}`);
}

/**
 * Warning level logging - potentially harmful situations
 */
function warn(message, meta = {}) {
    if (CURRENT_LOG_LEVEL > LOG_LEVELS.WARN) return;
    console.warn(`[WARN] ${message}${formatMeta(meta)}`);
}

/**
 * Error level logging - error events that might still allow the application to continue
 */
function error(message, error = null, meta = {}) {
    if (CURRENT_LOG_LEVEL > LOG_LEVELS.ERROR) return;
    console.error(`[ERROR] ${message}${formatError(error)}${formatMeta(meta)}`);
}

/**
 * Fatal level logging - severe errors that will lead to application abort
 */
function fatal(message, error = null, meta = {}) {
    console.error(`[FATAL] ${message}${formatError(error)}${formatMeta(meta)}`);
}

/**
 * Create a scoped logger with a context prefix
 * Useful for adding module/component context to all logs
 */
function scoped(scope) {
    return {
        debug: (msg, meta) => debug(`[${scope}] ${msg}`, meta),
        info: (msg, meta) => info(`[${scope}] ${msg}`, meta),
        warn: (msg, meta) => warn(`[${scope}] ${msg}`, meta),
        error: (msg, err, meta) => error(`[${scope}] ${msg}`, err, meta),
        fatal: (msg, err, meta) => fatal(`[${scope}] ${msg}`, err, meta)
    };
}

/**
 * Time a function execution and log the duration
 */
async function time(label, fn, logLevel = 'info') {
    const start = Date.now();
    try {
        const result = await fn();
        const duration = Date.now() - start;
        logger[logLevel](`${label} completed`, { durationMs: duration });
        return result;
    } catch (error) {
        const duration = Date.now() - start;
        logger.error(`${label} failed`, error, { durationMs: duration });
        throw error;
    }
}

export const logger = {
    debug,
    info,
    warn,
    error,
    fatal,
    scoped,
    time,
    levels: LOG_LEVELS
};

export default logger;
