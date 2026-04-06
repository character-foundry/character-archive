import { logger } from '../utils/logger.js';

const log = logger.scoped('DB:Schema');

const CARD_TAGS_TABLE_NAME = 'card_tags';

function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = Array.isArray(columns) && columns.some(column => column.name === columnName);
    if (!exists) {
        db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    }
}

export function ensureSchema(db) {
    log.info('Ensuring database schema...');
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY,
            author TEXT,
            name TEXT,
            tagline TEXT,
            description TEXT,
            topics TEXT,
            tokenCount INTEGER,
            tokenDescriptionCount INTEGER,
            tokenPersonalityCount INTEGER,
            tokenScenarioCount INTEGER,
            tokenMesExampleCount INTEGER,
            tokenFirstMessageCount INTEGER,
            tokenSystemPromptCount INTEGER,
            tokenPostHistoryCount INTEGER,
            lastModified TEXT,
            createdAt TEXT,
            firstDownloadedAt TEXT,
            nChats INTEGER,
            nMessages INTEGER,
            n_favorites INTEGER,
            starCount INTEGER,
            ratingsEnabled INTEGER,
            rating REAL,
            ratingCount INTEGER,
            ratings TEXT,
            fullPath TEXT,
            favorited INTEGER DEFAULT 0,
            language TEXT DEFAULT 'unknown',
            visibility TEXT DEFAULT 'unknown',
            hasAlternateGreetings INTEGER DEFAULT 0,
            hasLorebook INTEGER DEFAULT 0,
            hasEmbeddedLorebook INTEGER DEFAULT 0,
            hasLinkedLorebook INTEGER DEFAULT 0,
            hasExampleDialogues INTEGER DEFAULT 0,
            hasSystemPrompt INTEGER DEFAULT 0,
            hasGallery INTEGER DEFAULT 0,
            hasEmbeddedImages INTEGER DEFAULT 0,
            hasExpressions INTEGER DEFAULT 0,
            isFuzzed INTEGER DEFAULT 0,
            source TEXT DEFAULT 'chub',
            sourceId TEXT,
            sourcePath TEXT,
            sourceUrl TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_topics ON cards(topics);
        CREATE INDEX IF NOT EXISTS idx_author ON cards(author);
        CREATE INDEX IF NOT EXISTS idx_name ON cards(name);
        CREATE INDEX IF NOT EXISTS idx_language ON cards(language);
        CREATE INDEX IF NOT EXISTS idx_favorited ON cards(favorited);
        CREATE INDEX IF NOT EXISTS idx_visibility ON cards(visibility);
        CREATE INDEX IF NOT EXISTS idx_first_downloaded ON cards(firstDownloadedAt);

        CREATE TABLE IF NOT EXISTS cached_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cardId INTEGER NOT NULL,
            originalUrl TEXT NOT NULL,
            localPath TEXT NOT NULL,
            assetType TEXT NOT NULL,
            fileSize INTEGER,
            cachedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(cardId, originalUrl),
            FOREIGN KEY (cardId) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_cached_assets_card ON cached_assets(cardId);

        CREATE TABLE IF NOT EXISTS ${CARD_TAGS_TABLE_NAME} (
            cardId INTEGER NOT NULL,
            tag TEXT NOT NULL,
            normalizedTag TEXT NOT NULL,
            PRIMARY KEY(cardId, normalizedTag),
            FOREIGN KEY (cardId) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_card_tags_normalized ON ${CARD_TAGS_TABLE_NAME}(normalizedTag);
        CREATE INDEX IF NOT EXISTS idx_card_tags_card ON ${CARD_TAGS_TABLE_NAME}(cardId);

        CREATE TABLE IF NOT EXISTS search_index_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cardId TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
            queuedAt TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_search_index_queue_card ON search_index_queue(cardId);
        CREATE INDEX IF NOT EXISTS idx_search_index_queue_action ON search_index_queue(action);

        CREATE TABLE IF NOT EXISTS vector_index_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cardId TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
            queuedAt TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_vector_index_queue_card ON vector_index_queue(cardId);
        CREATE INDEX IF NOT EXISTS idx_vector_index_queue_action ON vector_index_queue(action);

        CREATE TABLE IF NOT EXISTS png_optimization_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cardId INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(cardId)
        );

        CREATE INDEX IF NOT EXISTS idx_png_optimization_queue_card ON png_optimization_queue(cardId);

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_insert_search_queue
        AFTER INSERT ON cards
        BEGIN
            INSERT INTO search_index_queue(cardId, action) VALUES (NEW.id, 'upsert');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_update_search_queue
        AFTER UPDATE ON cards
        BEGIN
            INSERT INTO search_index_queue(cardId, action) VALUES (NEW.id, 'upsert');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_delete_search_queue
        AFTER DELETE ON cards
        BEGIN
            INSERT INTO search_index_queue(cardId, action) VALUES (OLD.id, 'delete');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_insert_vector_queue
        AFTER INSERT ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (NEW.id, 'upsert');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_update_vector_queue
        AFTER UPDATE ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (NEW.id, 'upsert');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_delete_vector_queue
        AFTER DELETE ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (OLD.id, 'delete');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_insert_png_opt_queue
        AFTER INSERT ON cards
        WHEN NEW.source != 'risuai'
        BEGIN
            INSERT OR IGNORE INTO png_optimization_queue(cardId) VALUES (NEW.id);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_cards_after_update_png_opt_queue
        AFTER UPDATE ON cards
        WHEN NEW.source != 'risuai'
        BEGIN
            INSERT OR IGNORE INTO png_optimization_queue(cardId) VALUES (NEW.id);
        END;

        CREATE TABLE IF NOT EXISTS card_embedding_meta (
            cardId TEXT NOT NULL,
            embedder_name TEXT NOT NULL,
            model_name TEXT NOT NULL,
            dims INTEGER NOT NULL,
            section TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text_sha256 TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (cardId, embedder_name, section, chunk_index),
            FOREIGN KEY (cardId) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_card_embedding_meta_card ON card_embedding_meta(cardId);
        CREATE INDEX IF NOT EXISTS idx_card_embedding_meta_section ON card_embedding_meta(section);

        CREATE TABLE IF NOT EXISTS card_chunk_map (
            id TEXT PRIMARY KEY,
            cardId TEXT NOT NULL,
            section TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            start_token INTEGER,
            end_token INTEGER,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (cardId) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_card_chunk_map_card ON card_chunk_map(cardId);
        CREATE INDEX IF NOT EXISTS idx_card_chunk_map_section ON card_chunk_map(section);

        CREATE TABLE IF NOT EXISTS metrics_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_date TEXT NOT NULL,
            metric_type TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(snapshot_date, metric_type)
        );

        CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_date ON metrics_snapshots(snapshot_date);
        CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_type ON metrics_snapshots(metric_type);
    `);

    addColumnIfMissing(db, 'cached_assets', 'metadata', 'TEXT');
    addColumnIfMissing(db, 'cards', 'hasAlternateGreetings', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasLorebook', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasEmbeddedLorebook', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasLinkedLorebook', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasExampleDialogues', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasSystemPrompt', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasGallery', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasEmbeddedImages', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'hasExpressions', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'isFuzzed', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'cards', 'tokenDescriptionCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenPersonalityCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenScenarioCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenMesExampleCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenFirstMessageCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenSystemPromptCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'tokenPostHistoryCount', 'INTEGER');
    addColumnIfMissing(db, 'cards', 'firstDownloadedAt', 'TEXT');
    addColumnIfMissing(db, 'cards', 'source', "TEXT DEFAULT 'chub'");
    addColumnIfMissing(db, 'cards', 'sourceId', 'TEXT');
    addColumnIfMissing(db, 'cards', 'sourcePath', 'TEXT');
    addColumnIfMissing(db, 'cards', 'sourceUrl', 'TEXT');

    db.prepare("UPDATE cards SET source = 'chub' WHERE source IS NULL OR source = ''").run();
}
