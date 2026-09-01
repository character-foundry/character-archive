import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('loading processed card metadata is read-only', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-archive-card-metadata-'));
    const cardId = 989900001;
    const staticDirectory = path.join(process.cwd(), 'static', String(cardId).slice(0, 2));
    const metadataPath = path.join(staticDirectory, `${cardId}.json`);
    process.env.CHARACTER_ARCHIVE_DB_FILE = path.join(directory, 'cards.db');
    process.env.CHARACTER_ARCHIVE_CONFIG_FILE = path.join(directory, 'config.json');
    fs.mkdirSync(staticDirectory, { recursive: true });
    fs.writeFileSync(process.env.CHARACTER_ARCHIVE_CONFIG_FILE, JSON.stringify({ port: 6969 }));
    fs.writeFileSync(metadataPath, JSON.stringify({
        name: 'Read-only metadata fixture',
        hasLorebook: true,
        definition: { data: { name: 'Read-only metadata fixture', description: 'fixture' } }
    }));

    const databaseModule = await import('../database.js');
    const { closeConnection } = await import('../db/connection.js');
    const { getCardMetadata } = await import('./CardMetadataService.js');
    try {
        const database = databaseModule.initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
        database.prepare('INSERT INTO cards (id, name, hasLorebook) VALUES (?, ?, 1)')
            .run(cardId, 'Read-only metadata fixture');
        database.prepare('DELETE FROM search_index_queue').run();
        database.prepare('DELETE FROM vector_index_queue').run();

        const metadata = await getCardMetadata(cardId);

        assert.equal(metadata.name, 'Read-only metadata fixture');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM search_index_queue').get().count, 0);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_index_queue').get().count, 0);
    } finally {
        closeConnection();
        fs.rmSync(metadataPath, { force: true });
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
