import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

const log = logger.scoped('DB:Conn');

let db = null;

/**
 * Initialize the database connection
 * @param {string} databaseFile - Path to the SQLite database file
 * @returns {Database} - The better-sqlite3 database instance
 */
export function createConnection(databaseFile) {
    if (db) {
        return db;
    }

    try {
        log.info(`Connecting to database at ${databaseFile}`);
        db = new Database(databaseFile);

        // Set optimized PRAGMAs for better-sqlite3
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        db.pragma(`busy_timeout = ${Math.max(1000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 15000)}`);
        db.pragma('cache_size = -64000');  // 64MB cache
        db.pragma('temp_store = MEMORY');
        const mmapBytes = Math.max(0, Number(process.env.SQLITE_MMAP_SIZE) || 536870912);
        db.pragma(`mmap_size = ${mmapBytes}`);  // 512MB default; bounded by the container instead of mapping tens of GB.

        return db;
    } catch (error) {
        log.error('Failed to create database connection', error);
        throw error;
    }
}

/**
 * Get the existing database instance
 * @throws {Error} if database is not initialized
 * @returns {Database}
 */
export function getDbInstance() {
    if (!db) {
        throw new Error('Database not initialized. Call createConnection() first.');
    }
    return db;
}

/**
 * Close the database connection
 */
export function closeConnection() {
    if (db) {
        db.close();
        db = null;
        log.info('Database connection closed');
    }
}

/**
 * Execute a function within a database transaction
 * Provides atomicity for multi-statement operations
 *
 * @param {Function} callback - Function to execute within transaction. Receives db as parameter.
 * @returns {*} - Result from callback function
 */
export function withTransaction(callback) {
    const database = getDbInstance();

    // Use better-sqlite3 transaction API
    const transaction = database.transaction(callback);
    return transaction(database);
}
