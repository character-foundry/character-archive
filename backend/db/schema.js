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
        DELETE FROM vector_index_queue
        WHERE id NOT IN (
            SELECT MAX(id)
            FROM vector_index_queue
            GROUP BY cardId
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_index_queue_card_unique ON vector_index_queue(cardId);

        CREATE TABLE IF NOT EXISTS vector_generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            model_name TEXT NOT NULL,
            embedder_name TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK(dimensions > 0),
            cards_index TEXT NOT NULL,
            chunks_index TEXT,
            status TEXT NOT NULL DEFAULT 'building'
                CHECK(status IN ('building','ready','active','failed','retired')),
            active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
            cursor_card_id TEXT,
            expected_cards INTEGER NOT NULL DEFAULT 0,
            indexed_cards INTEGER NOT NULL DEFAULT 0,
            indexed_chunks INTEGER NOT NULL DEFAULT 0,
            failed_items INTEGER NOT NULL DEFAULT 0,
            quality_report TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            activated_at TEXT,
            completed_at TEXT,
            retire_after TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_generations_one_active
        ON vector_generations(active) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS idx_vector_generations_status
        ON vector_generations(status, created_at);

        CREATE TABLE IF NOT EXISTS vector_work_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generation_id INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'upsert' CHECK(action IN ('upsert','delete')),
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','leased','submitted','completed','retry','dead')),
            attempts INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            leased_revision INTEGER,
            next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            lease_owner TEXT,
            lease_expires_at TEXT,
            meili_task_uids TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            UNIQUE(generation_id, card_id),
            FOREIGN KEY (generation_id) REFERENCES vector_generations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_vector_work_items_claim
        ON vector_work_items(generation_id, status, next_attempt_at, id);
        CREATE INDEX IF NOT EXISTS idx_vector_work_items_lease
        ON vector_work_items(status, lease_expires_at);

        CREATE TABLE IF NOT EXISTS sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trigger_type TEXT NOT NULL DEFAULT 'manual'
                CHECK(trigger_type IN ('manual','scheduled','startup-catchup','legacy-api','repair')),
            schedule_key TEXT UNIQUE,
            requested_sources TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','running','success','partial','failed','cancelled','skipped')),
            scheduled_for TEXT,
            requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT,
            finished_at TEXT,
            lease_owner TEXT,
            lease_expires_at TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
            current_source TEXT,
            added INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            error_summary TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sync_runs_claim
        ON sync_runs(status, requested_at, id);
        CREATE INDEX IF NOT EXISTS idx_sync_runs_lease
        ON sync_runs(status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_sync_runs_finished
        ON sync_runs(finished_at);

        CREATE TABLE IF NOT EXISTS sync_source_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','running','success','partial','failed','cancelled','skipped')),
            started_at TEXT,
            finished_at TEXT,
            added INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            cursor TEXT,
            error_message TEXT,
            UNIQUE(run_id, source),
            FOREIGN KEY (run_id) REFERENCES sync_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sync_source_runs_run
        ON sync_source_runs(run_id, id);

        CREATE TABLE IF NOT EXISTS sync_run_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            source TEXT,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES sync_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sync_run_events_run
        ON sync_run_events(run_id, id);

        CREATE TABLE IF NOT EXISTS card_source_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            source_id TEXT,
            source_path TEXT,
            canonical_card_id INTEGER NOT NULL,
            retired_card_id INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source, source_path, retired_card_id),
            FOREIGN KEY (canonical_card_id) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_card_source_aliases_canonical
        ON card_source_aliases(canonical_card_id);

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

        DROP TRIGGER IF EXISTS trg_cards_after_insert_vector_queue;
        DROP TRIGGER IF EXISTS trg_cards_after_update_vector_queue;
        DROP TRIGGER IF EXISTS trg_cards_after_delete_vector_queue;

        CREATE TRIGGER trg_cards_after_insert_vector_queue
        AFTER INSERT ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (NEW.id, 'upsert')
            ON CONFLICT(cardId) DO UPDATE SET action = excluded.action, queuedAt = CURRENT_TIMESTAMP;
            UPDATE vector_generations
            SET status = 'building', completed_at = NULL
            WHERE status = 'ready';
            INSERT INTO vector_work_items (generation_id, card_id, action)
            SELECT id, CAST(NEW.id AS TEXT), 'upsert'
            FROM vector_generations WHERE active = 1 OR status = 'building'
            ON CONFLICT(generation_id, card_id) DO UPDATE SET
                action = 'upsert', status = 'queued', revision = vector_work_items.revision + 1,
                next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
        END;

        CREATE TRIGGER trg_cards_after_update_vector_queue
        AFTER UPDATE ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (NEW.id, 'upsert')
            ON CONFLICT(cardId) DO UPDATE SET action = excluded.action, queuedAt = CURRENT_TIMESTAMP;
            UPDATE vector_generations
            SET status = 'building', completed_at = NULL
            WHERE status = 'ready';
            INSERT INTO vector_work_items (generation_id, card_id, action)
            SELECT id, CAST(NEW.id AS TEXT), 'upsert'
            FROM vector_generations WHERE active = 1 OR status = 'building'
            ON CONFLICT(generation_id, card_id) DO UPDATE SET
                action = 'upsert', status = 'queued', revision = vector_work_items.revision + 1,
                next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
        END;

        CREATE TRIGGER trg_cards_after_delete_vector_queue
        AFTER DELETE ON cards
        BEGIN
            INSERT INTO vector_index_queue(cardId, action) VALUES (OLD.id, 'delete')
            ON CONFLICT(cardId) DO UPDATE SET action = excluded.action, queuedAt = CURRENT_TIMESTAMP;
            UPDATE vector_generations
            SET status = 'building', completed_at = NULL
            WHERE status = 'ready';
            INSERT INTO vector_work_items (generation_id, card_id, action)
            SELECT id, CAST(OLD.id AS TEXT), 'delete'
            FROM vector_generations WHERE active = 1 OR status = 'building'
            ON CONFLICT(generation_id, card_id) DO UPDATE SET
                action = 'delete', status = 'queued', revision = vector_work_items.revision + 1,
                next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
        END;

        DROP TRIGGER IF EXISTS trg_cards_after_insert_png_opt_queue;
        DROP TRIGGER IF EXISTS trg_cards_after_update_png_opt_queue;

        CREATE TRIGGER trg_cards_after_insert_png_opt_queue
        AFTER INSERT ON cards
        WHEN NEW.source != 'risuai'
        BEGIN
            INSERT INTO png_optimization_queue(cardId) VALUES (NEW.id)
            ON CONFLICT(cardId) DO NOTHING;
        END;

        CREATE TRIGGER trg_cards_after_update_png_opt_queue
        AFTER UPDATE ON cards
        WHEN NEW.source != 'risuai'
        BEGIN
            INSERT INTO png_optimization_queue(cardId) VALUES (NEW.id)
            ON CONFLICT(cardId) DO NOTHING;
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
    addColumnIfMissing(db, 'vector_work_items', 'revision', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'vector_work_items', 'leased_revision', 'INTEGER');

    db.prepare("UPDATE cards SET source = 'chub' WHERE source IS NULL OR source = ''").run();
}
