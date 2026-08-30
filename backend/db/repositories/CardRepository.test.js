import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createConnection, closeConnection } from '../connection.js';
import { ensureSchema } from '../schema.js';
import { upsertCard, getCards, deleteCard, toggleFavorite, getCardsByIdsOrdered } from './CardRepository.js';

// Use in-memory database
const DB_PATH = ':memory:';

describe('CardRepository', () => {
    let db;

    before(() => {
        db = createConnection(DB_PATH);
        ensureSchema(db);
    });

    after(() => {
        closeConnection();
    });
    
    // Helper to clear tables
    const clearTables = () => {
        db.prepare('DELETE FROM cards').run();
        db.prepare('DELETE FROM card_tags').run();
    };

    beforeEach(() => {
        clearTables();
    });

    it('should upsert a card', () => {
        const cardData = {
            id: 1,
            name: 'Test Card',
            topics: 'tag1,tag2',
            description: 'A test card',
            tagline: 'Testing',
            author: 'Tester',
            source: 'chub'
        };
        
        upsertCard(cardData);
        
        const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(1);
        assert.ok(row);
        assert.strictEqual(row.name, 'Test Card');
        
        // Check tags
        const tags = db.prepare('SELECT * FROM card_tags WHERE cardId = ?').all(1);
        assert.strictEqual(tags.length, 2);
    });

    it('should update a card without cascading deletion to cached assets', () => {
        upsertCard({ id: 1, name: 'Before', topics: 'old' });
        db.prepare(`
            INSERT INTO cached_assets (cardId, originalUrl, localPath, assetType)
            VALUES (1, 'https://example.test/expression.png', '/static/expression.png', 'expression')
        `).run();

        upsertCard({ id: 1, name: 'After', topics: 'new' });

        assert.strictEqual(db.prepare('SELECT name FROM cards WHERE id = 1').get().name, 'After');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM cached_assets WHERE cardId = 1').get().count, 1);
    });
    
    it('should get cards with pagination', () => {
        // Insert 50 cards
        const insert = db.prepare('INSERT INTO cards (id, name) VALUES (?, ?)');
        const insertTag = db.prepare('INSERT INTO card_tags (cardId, tag, normalizedTag) VALUES (?, ?, ?)');
        
        db.transaction(() => {
            for (let i = 1; i <= 50; i++) {
                insert.run(i, `Card ${i}`);
                // Add a tag to ensure no join errors
                insertTag.run(i, 'test', 'test');
            }
        })();
        
        const result = getCards({ page: 1, limit: 10 });
        assert.strictEqual(result.cards.length, 10);
        assert.strictEqual(result.count, 50);
        assert.strictEqual(result.totalPages, 5);
        
        const page2 = getCards({ page: 2, limit: 10 });
        assert.strictEqual(page2.page, 2);
        assert.strictEqual(page2.cards.length, 10);
    });

    it('should filter by query (full text)', () => {
         upsertCard({ id: 1, name: 'Apple', description: 'Red fruit', topics: 'food' });
         upsertCard({ id: 2, name: 'Banana', description: 'Yellow fruit', topics: 'food' });
         
         const result = getCards({ query: 'Apple' });
         assert.strictEqual(result.cards.length, 1);
         assert.strictEqual(result.cards[0].name, 'Apple');
         
         const resultDesc = getCards({ query: 'Yellow' });
         assert.strictEqual(resultDesc.cards.length, 1);
         assert.strictEqual(resultDesc.cards[0].name, 'Banana');
    });
    
    it('should delete a card', () => {
        upsertCard({ id: 1, name: 'To Delete' });
        assert.ok(db.prepare('SELECT * FROM cards WHERE id = 1').get());
        
        deleteCard(1);
        assert.ok(!db.prepare('SELECT * FROM cards WHERE id = 1').get());
    });
    
    it('should toggle favorite', () => {
        upsertCard({ id: 1, name: 'Fav Test', favorited: 0 });
        
        toggleFavorite(1);
        let row = db.prepare('SELECT favorited FROM cards WHERE id = 1').get();
        assert.strictEqual(row.favorited, 1);
        
        toggleFavorite(1);
        row = db.prepare('SELECT favorited FROM cards WHERE id = 1').get();
        assert.strictEqual(row.favorited, 0);
    });
    
    it('should get cards by IDs ordered', () => {
        upsertCard({ id: 1, name: 'One' });
        upsertCard({ id: 2, name: 'Two' });
        upsertCard({ id: 3, name: 'Three' });
        
        const result = getCardsByIdsOrdered([3, 1, 2]);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].id, '3');
        assert.strictEqual(result[1].id, '1');
        assert.strictEqual(result[2].id, '2');
    });
});
