import fs from 'node:fs/promises';
import path from 'node:path';

import * as lancedb from '@lancedb/lancedb';
import { Bool, Field, FixedSizeList, Float32, Float64, List, Schema, Utf8 } from 'apache-arrow';

import { logger } from '../../utils/logger.js';
import { requestEmbeddings } from '../EmbeddingClient.js';
import { compileLanceFilter } from './lance-filter.js';

const log = logger.scoped('SEARCH:LANCE');

const STRING_FIELDS = [
    'id', 'name', 'tagline', 'description', 'platform_summary', 'author',
    'source', 'sourceId', 'sourcePath', 'sourceSpecific', 'fullPath', 'type',
    'language', 'visibility', 'created', 'createdAt', 'added', 'updated',
    'lastModified', 'searchText'
];
const BOOLEAN_FIELDS = [
    'hasAlternateGreetings', 'hasLorebook', 'hasEmbeddedLorebook',
    'hasLinkedLorebook', 'hasExampleDialogues', 'hasSystemPrompt',
    'hasGallery', 'hasEmbeddedImages', 'hasExpressions'
];
const NUMBER_FIELDS = [
    'favorited', 'tokenCount', 'token_count', 'rating', 'ratingCount',
    'starCount', 'n_favorites', 'favorites', 'nChats', 'nMessages',
    'tokenDescriptionCount', 'tokenPersonalityCount', 'tokenScenarioCount',
    'tokenMesExampleCount', 'tokenFirstMessageCount', 'tokenSystemPromptCount',
    'tokenPostHistoryCount', 'scoreComposite', 'scoreVelocity',
    'engagementScore', 'engagementVelocity'
];

const LANCE_SCHEMA = new Schema([
    ...STRING_FIELDS.map(name => new Field(name, new Utf8(), false)),
    new Field('tags', new List(new Field('item', new Utf8(), false)), false),
    new Field('topics', new List(new Field('item', new Utf8(), false)), false),
    ...BOOLEAN_FIELDS.map(name => new Field(name, new Bool(), false)),
    ...NUMBER_FIELDS.map(name => new Field(name, new Float64(), false))
]);

const SORT_MAP = Object.freeze({
    new: [{ columnName: 'lastModified', ascending: false }, { columnName: 'id', ascending: false }],
    old: [{ columnName: 'lastModified', ascending: true }, { columnName: 'id', ascending: true }],
    create_new: [{ columnName: 'createdAt', ascending: false }, { columnName: 'id', ascending: false }],
    create_old: [{ columnName: 'createdAt', ascending: true }, { columnName: 'id', ascending: true }],
    tokens_desc: [{ columnName: 'tokenCount', ascending: false }, { columnName: 'id', ascending: false }],
    tokens_asc: [{ columnName: 'tokenCount', ascending: true }, { columnName: 'id', ascending: true }],
    most_stars_desc: [{ columnName: 'starCount', ascending: false }, { columnName: 'id', ascending: false }],
    most_stars_asc: [{ columnName: 'starCount', ascending: true }, { columnName: 'id', ascending: true }],
    most_favs_desc: [{ columnName: 'n_favorites', ascending: false }, { columnName: 'id', ascending: false }],
    most_favs_asc: [{ columnName: 'n_favorites', ascending: true }, { columnName: 'id', ascending: true }],
    most_msgs_desc: [{ columnName: 'nMessages', ascending: false }, { columnName: 'id', ascending: false }],
    most_msgs_asc: [{ columnName: 'nMessages', ascending: true }, { columnName: 'id', ascending: true }],
    most_chats_desc: [{ columnName: 'nChats', ascending: false }, { columnName: 'id', ascending: false }],
    most_chats_asc: [{ columnName: 'nChats', ascending: true }, { columnName: 'id', ascending: true }],
    overall_rating_desc: [{ columnName: 'scoreComposite', ascending: false }, { columnName: 'id', ascending: false }],
    overall_rating_asc: [{ columnName: 'scoreComposite', ascending: true }, { columnName: 'id', ascending: true }],
    trending_desc: [{ columnName: 'scoreVelocity', ascending: false }, { columnName: 'id', ascending: false }],
    trending_asc: [{ columnName: 'scoreVelocity', ascending: true }, { columnName: 'id', ascending: true }],
    engagement_desc: [{ columnName: 'engagementScore', ascending: false }, { columnName: 'id', ascending: false }],
    engagement_asc: [{ columnName: 'engagementScore', ascending: true }, { columnName: 'id', ascending: true }],
    fresh_engagement_desc: [{ columnName: 'engagementVelocity', ascending: false }, { columnName: 'id', ascending: false }],
    fresh_engagement_asc: [{ columnName: 'engagementVelocity', ascending: true }, { columnName: 'id', ascending: true }]
});

function cleanString(value) {
    return value === null || typeof value === 'undefined' ? '' : String(value);
}

export function normalizeLanceDocument(document = {}) {
    const normalized = {};
    for (const field of STRING_FIELDS) normalized[field] = cleanString(document[field]);
    normalized.tags = Array.isArray(document.tags) ? document.tags.map(cleanString).filter(Boolean) : [];
    normalized.topics = Array.isArray(document.topics) ? document.topics.map(cleanString).filter(Boolean) : [...normalized.tags];
    for (const field of BOOLEAN_FIELDS) normalized[field] = Boolean(document[field]);
    for (const field of NUMBER_FIELDS) normalized[field] = Number(document[field]) || 0;
    normalized.searchText = [
        normalized.name,
        normalized.tagline,
        normalized.description,
        normalized.platform_summary,
        normalized.author,
        normalized.tags.join(' '),
        normalized.source,
        normalized.sourcePath,
        normalized.fullPath
    ].filter(Boolean).join('\n');
    return normalized;
}

function arrowTable(documents) {
    return lancedb.makeArrowTable(documents.map(normalizeLanceDocument), { schema: LANCE_SCHEMA });
}

function vectorSchema(dimensions) {
    return new Schema([
        new Field('card_id', new Utf8(), false),
        new Field('section', new Utf8(), false),
        new Field('matchText', new Utf8(), false),
        ...LANCE_SCHEMA.fields,
        new Field('vector', new FixedSizeList(dimensions, new Field('item', new Float32(), false)), false)
    ]);
}

function normalizeVectorDocument(item, dimensions) {
    const document = normalizeLanceDocument(item.document);
    const vector = Array.from(item.vector || [], Number);
    if (vector.length !== dimensions) {
        throw new Error(`LanceDB vector dimension mismatch: expected ${dimensions}, received ${vector.length}`);
    }
    return {
        card_id: document.id,
        section: cleanString(item.section || 'card'),
        matchText: cleanString(item.text || document.description || document.searchText),
        ...document,
        vector
    };
}

function quoted(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

export class LanceSearchBackend {
    constructor({
        uri,
        tableName = 'cards',
        vectorTableName = 'card_vectors',
        vectorConfig = {},
        batchSize = 2000,
        maxTotalHits = 10000,
        embeddingRequest = requestEmbeddings
    } = {}) {
        this.uri = cleanString(uri);
        this.tableName = cleanString(tableName) || 'cards';
        this.batchSize = Math.max(1, Number(batchSize) || 2000);
        this.maxTotalHits = Math.max(100, Number(maxTotalHits) || 10000);
        this.vectorTableName = cleanString(vectorTableName) || 'card_vectors';
        this.vectorConfig = { ...vectorConfig };
        this.embeddingRequest = embeddingRequest;
        this.connection = null;
        this.table = null;
        this.activeTableName = null;
        this.vectorTable = null;
        this.vectorAvailable = false;
        this.openPromise = null;
    }

    get enabled() {
        return Boolean(this.uri);
    }

    get vectorReady() {
        return Boolean(
            this.vectorAvailable
            && this.vectorConfigured
        );
    }

    get vectorConfigured() {
        return Boolean(
            this.enabled
            && this.vectorConfig?.enabled === true
            && Number(this.vectorConfig?.embedDimensions) > 0
            && (this.vectorConfig?.embeddingUrl || this.vectorConfig?.ollamaUrl)
        );
    }

    async probeVectorReady() {
        if (!this.vectorConfigured) return false;
        this.vectorAvailable = Boolean(await this.openVectorTable({ requireTable: false }));
        return this.vectorAvailable;
    }

    async getConnection() {
        if (!this.enabled) throw new Error('LanceDB search path is not configured');
        if (!this.connection) {
            await fs.mkdir(this.uri, { recursive: true });
            this.connection = await lancedb.connect(this.uri);
        }
        return this.connection;
    }

    get activeTablePointerPath() {
        return path.join(this.uri, `.${this.tableName}.active.json`);
    }

    async resolveActiveTableName(tableNames) {
        try {
            const pointer = JSON.parse(await fs.readFile(this.activeTablePointerPath, 'utf8'));
            const name = cleanString(pointer?.tableName);
            if ((name === this.tableName || name.startsWith(`${this.tableName}_build_`)) && tableNames.includes(name)) {
                return name;
            }
            log.warn(`Ignoring invalid LanceDB active-table pointer for ${this.tableName}`);
        } catch (error) {
            if (error?.code !== 'ENOENT') log.warn(`Failed to read LanceDB active-table pointer for ${this.tableName}`, error);
        }
        return tableNames.includes(this.tableName) ? this.tableName : null;
    }

    async writeActiveTablePointer(tableName) {
        const pointerPath = this.activeTablePointerPath;
        const temporaryPath = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(`${JSON.stringify({ tableName, activatedAt: new Date().toISOString() })}\n`);
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporaryPath, pointerPath);
            const directory = await fs.open(this.uri, 'r');
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.unlink(temporaryPath).catch(error => {
                if (error?.code !== 'ENOENT') throw error;
            });
        }
    }

    async open({ requireTable = true } = {}) {
        if (!this.enabled) throw new Error('LanceDB search path is not configured');
        if (this.table) return this.table;
        if (!this.openPromise) {
            this.openPromise = (async () => {
                await fs.mkdir(this.uri, { recursive: true });
                await this.getConnection();
                const names = await this.connection.tableNames();
                const activeTableName = await this.resolveActiveTableName(names);
                if (!activeTableName) {
                    if (requireTable) throw new Error(`LanceDB search table "${this.tableName}" has not been built and activated`);
                    return null;
                }
                this.activeTableName = activeTableName;
                this.table = await this.connection.openTable(activeTableName);
                return this.table;
            })().finally(() => {
                this.openPromise = null;
            });
        }
        return this.openPromise;
    }

    async isReady() {
        try {
            return Boolean(await this.open());
        } catch {
            return false;
        }
    }

    async rebuild(documents = []) {
        const normalized = Array.isArray(documents) ? documents.filter(Boolean) : [];
        if (!normalized.length) throw new Error('Cannot build an empty LanceDB search index');
        const batchSize = this.batchSize;
        return this.rebuildBatches((async function* () {
            for (let offset = 0; offset < normalized.length; offset += batchSize) {
                yield normalized.slice(offset, offset + batchSize);
            }
        })());
    }

    async rebuildBatches(batches) {
        if (!batches || typeof batches[Symbol.asyncIterator] !== 'function') {
            throw new TypeError('LanceDB rebuild batches must be an async iterable');
        }
        const connection = await this.getConnection();
        const shadowName = `${this.tableName}_build_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
        const previousTable = this.table;
        let shadowTable = null;
        let documents = 0;
        let activated = false;
        try {
            for await (const batch of batches) {
                const rows = Array.isArray(batch) ? batch.filter(Boolean) : [];
                if (!rows.length) continue;
                if (!shadowTable) {
                    shadowTable = await connection.createTable(shadowName, arrowTable(rows), { mode: 'create' });
                } else {
                    await shadowTable.add(arrowTable(rows));
                }
                documents += rows.length;
            }
            if (!shadowTable || !documents) throw new Error('Cannot build an empty LanceDB search index');
            await this.createIndexes(shadowTable);
            await this.writeActiveTablePointer(shadowName);
            activated = true;
            this.table = shadowTable;
            this.activeTableName = shadowName;
            if (previousTable && previousTable !== shadowTable) {
                try {
                    await previousTable.close();
                } catch (error) {
                    log.warn('Failed to close the previous LanceDB search table', error);
                }
            }
            log.info(`LanceDB search index rebuilt and activated (${documents} documents)`);
            return { documents };
        } catch (error) {
            if (!activated && shadowTable) {
                try { await shadowTable.close(); } catch {}
                await connection.dropTable(shadowName).catch(cleanupError => {
                    log.warn(`Failed to remove incomplete LanceDB shadow table ${shadowName}`, cleanupError);
                });
            }
            throw error;
        }
    }

    async createIndexes(table = null) {
        table ||= await this.open();
        await table.createIndex('searchText', {
            config: lancedb.Index.fts({ withPosition: false, lowercase: true, asciiFolding: true }),
            replace: true
        });
    }

    async countRows(rawFilter = '') {
        const table = await this.open();
        return table.countRows(compileLanceFilter(rawFilter) || undefined);
    }

    async searchLexical({ text = '', filter = '', page = 1, limit = 48, sort = 'new' } = {}) {
        const table = await this.open();
        const appliedFilter = compileLanceFilter(filter);
        const queryText = cleanString(text).trim();
        const pageNumber = Math.max(1, Number(page) || 1);
        const perPage = Math.max(1, Math.min(Number(limit) || 48, 200));
        const offset = (pageNumber - 1) * perPage;

        if (queryText) {
            let query = table.search(queryText, 'fts', 'searchText').select(['id', '_score']);
            if (appliedFilter) query = query.where(appliedFilter);
            if (typeof sort === 'string' && SORT_MAP[sort]) query = query.orderBy(SORT_MAP[sort]);
            const hits = await query.limit(this.maxTotalHits).toArray();
            return {
                ids: hits.slice(offset, offset + perPage).map(hit => String(hit.id)),
                total: hits.length,
                raw: null,
                appliedFilter
            };
        }

        const total = await table.countRows(appliedFilter || undefined);
        let query = table.query().select(['id']);
        if (appliedFilter) query = query.where(appliedFilter);
        const sortRules = typeof sort === 'string' ? (SORT_MAP[sort] || SORT_MAP.new) : null;
        if (sortRules) query = query.orderBy(sortRules);
        const hits = await query.offset(offset).limit(perPage).toArray();
        return {
            ids: hits.map(hit => String(hit.id)),
            total,
            raw: null,
            appliedFilter
        };
    }

    async upsertDocuments(documents = []) {
        if (!Array.isArray(documents) || !documents.length) return;
        const table = await this.open();
        await table.mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(arrowTable(documents));
    }

    async openVectorTable({ requireTable = true, tableName = this.vectorTableName } = {}) {
        if (tableName === this.vectorTableName && this.vectorTable) return this.vectorTable;
        const connection = await this.getConnection();
        const names = await connection.tableNames();
        if (!names.includes(tableName)) {
            if (requireTable) throw new Error(`LanceDB vector table "${tableName}" has not been built`);
            return null;
        }
        const table = await connection.openTable(tableName);
        if (tableName === this.vectorTableName) {
            this.vectorTable = table;
            this.vectorAvailable = true;
        }
        return table;
    }

    async upsertVectorDocuments(items = [], { tableName = this.vectorTableName, dimensions } = {}) {
        if (!Array.isArray(items) || !items.length) return;
        const resolvedDimensions = Number(dimensions || this.vectorConfig?.embedDimensions || items[0]?.vector?.length);
        if (!Number.isInteger(resolvedDimensions) || resolvedDimensions <= 0) {
            throw new Error('LanceDB vector dimensions are not configured');
        }
        const schema = vectorSchema(resolvedDimensions);
        const rows = items.map(item => normalizeVectorDocument(item, resolvedDimensions));
        const data = lancedb.makeArrowTable(rows, { schema });
        const connection = await this.getConnection();
        let table = await this.openVectorTable({ requireTable: false, tableName });
        if (!table) {
            table = await connection.createTable(tableName, data, { mode: 'create' });
        } else {
            await table.mergeInsert('id')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute(data);
        }
        if (tableName === this.vectorTableName) this.vectorTable = table;
    }

    async deleteVectorDocuments(ids = [], { tableName = this.vectorTableName } = {}) {
        if (!Array.isArray(ids) || !ids.length) return;
        const table = await this.openVectorTable({ requireTable: false, tableName });
        if (table) await table.delete(`card_id IN (${ids.map(quoted).join(', ')})`);
    }

    async searchVector({ text = '', filter = '', page = 1, limit = 48 } = {}) {
        if (!this.vectorConfigured) throw new Error('LanceDB vector search is not configured');
        const queryText = cleanString(text).trim();
        if (!queryText) throw new Error('Vector search requires a query string');
        const dimensions = Number(this.vectorConfig.embedDimensions);
        const vectors = await this.embeddingRequest({
            provider: this.vectorConfig.embeddingProvider || 'ollama',
            baseUrl: this.vectorConfig.embeddingUrl || this.vectorConfig.ollamaUrl,
            apiKey: this.vectorConfig.embeddingApiKey || '',
            model: this.vectorConfig.embedModel,
            texts: [queryText],
            dimensions,
            normalize: true
        });
        const queryVector = vectors?.[0];
        if (!Array.isArray(queryVector) || queryVector.length !== dimensions) {
            throw new Error(`Embedding service returned an invalid ${dimensions}d query vector`);
        }
        const table = await this.openVectorTable();
        this.vectorAvailable = true;
        const appliedFilter = compileLanceFilter(filter);
        const pageNumber = Math.max(1, Number(page) || 1);
        const perPage = Math.max(1, Math.min(Number(limit) || 48, 200));
        const offset = (pageNumber - 1) * perPage;
        const candidateLimit = Math.min(
            this.maxTotalHits,
            Math.max(offset + perPage, Number(this.vectorConfig.maxCardHits) || 400)
        );
        let query = table.vectorSearch(queryVector)
            .select(['card_id', 'section', 'matchText', '_distance'])
            .distanceType('cosine')
            .limit(candidateLimit);
        if (appliedFilter) query = query.where(appliedFilter);
        const hits = await query.toArray();
        const unique = [];
        const seen = new Set();
        for (const hit of hits) {
            const id = String(hit.card_id);
            if (seen.has(id)) continue;
            seen.add(id);
            unique.push(hit);
        }
        const pageHits = unique.slice(offset, offset + perPage);
        const chunkMatches = {};
        const scores = {};
        for (const hit of pageHits) {
            const id = String(hit.card_id);
            const distance = Number(hit._distance);
            const score = Number.isFinite(distance) ? 1 / (1 + Math.max(0, distance)) : 0;
            chunkMatches[id] = {
                section: hit.section || 'card',
                text: hit.matchText || '',
                chunkIndex: null,
                startToken: null,
                endToken: null,
                score
            };
            scores[id] = score;
        }
        return {
            ids: pageHits.map(hit => String(hit.card_id)),
            total: unique.length,
            appliedFilter,
            chunkMatches,
            scores,
            meta: {
                provider: 'lancedb',
                semanticRatio: 1,
                cardsFetched: unique.length,
                chunksFetched: 0
            }
        };
    }

    async deleteDocumentsByIds(ids = []) {
        if (!Array.isArray(ids) || !ids.length) return;
        const table = await this.open();
        await table.delete(`id IN (${ids.map(quoted).join(', ')})`);
    }

    async optimize() {
        const table = await this.open();
        return table.optimize();
    }

    async createVectorIndex({ tableName = this.vectorTableName } = {}) {
        const table = await this.openVectorTable({ tableName });
        await table.createIndex('vector', {
            config: lancedb.Index.hnswSq({
                distanceType: 'cosine',
                numPartitions: 4,
                m: 20,
                efConstruction: 150
            }),
            replace: true,
            waitTimeoutSeconds: 3600
        });
        log.info(`LanceDB vector index built (${tableName})`);
    }

    async close() {
        const table = this.table;
        const vectorTable = this.vectorTable;
        const connection = this.connection;
        this.table = null;
        this.activeTableName = null;
        this.vectorTable = null;
        this.vectorAvailable = false;
        this.connection = null;
        this.openPromise = null;
        if (table) await table.close();
        if (vectorTable && vectorTable !== table) await vectorTable.close();
        if (connection) await connection.close();
    }
}

export { LANCE_SCHEMA, SORT_MAP as LANCE_SORT_MAP };
