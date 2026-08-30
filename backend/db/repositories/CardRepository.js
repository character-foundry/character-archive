import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { franc } from 'franc';
import { logger } from '../../utils/logger.js';
import { getDbInstance, withTransaction } from '../connection.js';
import {
    expandTagSearch,
    replaceCardTagsForDatabase,
    splitTopicsToArray,
    normalizeTagValue
} from './TagRepository.js';
import { TOKEN_COUNT_COLUMNS, resolveTokenCountsFromMetadata } from '../../utils/token-counts.js';

const log = logger.scoped('Repo:Cards');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fsp = fs.promises;
const STATIC_DIR = process.env.CHARACTER_ARCHIVE_STATIC_DIR || path.join(__dirname, '../../../static');
const CARDS_PER_PAGE = 48;
const CARD_TAGS_TABLE_NAME = 'card_tags';

export const LANGUAGE_MAPPING = {
    'eng': 'English', 'cat': 'Catalan', 'nld': 'Dutch', 'spa': 'Spanish',
    'fra': 'French', 'deu': 'German', 'ita': 'Italian', 'por': 'Portuguese',
    'cmn': 'Chinese', 'jpn': 'Japanese', 'kor': 'Korean', 'rus': 'Russian',
    'arb': 'Arabic', 'hin': 'Hindi', 'tgl': 'Tagalog', 'ind': 'Indonesian',
    'nor': 'Norwegian', 'hrv': 'Croatian', 'som': 'Somali', 'sqi': 'Albanian',
    'pol': 'Polish', 'est': 'Estonian', 'cym': 'Welsh', 'afr': 'Afrikaans',
    'swa': 'Swahili', 'slv': 'Slovenian', 'swe': 'Swedish', 'ron': 'Romanian',
    'tur': 'Turkish', 'dan': 'Danish', 'lit': 'Lithuanian', 'fin': 'Finnish',
    'vie': 'Vietnamese', 'hun': 'Hungarian', 'slk': 'Slovak', 'ces': 'Czech',
    'ben': 'Bengali', 'kan': 'Kannada', 'lav': 'Latvian', 'tam': 'Tamil',
    'ell': 'Greek', 'ukr': 'Ukrainian', 'bul': 'Bulgarian', 'fas': 'Persian',
    'mkd': 'Macedonian', 'heb': 'Hebrew', 'guj': 'Gujarati', 'mal': 'Malayalam',
    'tha': 'Thai', 'unknown': 'Unknown'
};

function getImageVersion(cardId) {
    if (!cardId) {
        return null;
    }
    try {
        const subfolder = cardId.substring(0, 2);
        const filePath = path.join(STATIC_DIR, subfolder, `${cardId}.png`);
        const stats = fs.statSync(filePath);
        return Math.floor(stats.mtimeMs || stats.mtime.getTime());
    } catch (error) {
        return null;
    }
}

function buildVersionedImagePath(cardId) {
    const basePath = `/static/${cardId.substring(0, 2)}/${cardId}.png`;
    const version = getImageVersion(cardId);
    if (!version) {
        return { path: basePath, version: null };
    }
    return { path: `${basePath}?v=${version}`, version };
}

function sanitizeCtPath(value = '') {
    if (!value || typeof value !== 'string') {
        return '';
    }
    return value.trim().replace(/^\/+/, '');
}

// Source URL configuration - maps source names to URL builders
const SOURCE_URL_CONFIG = {
    ct: {
        domain: 'character-tavern.com',
        buildUrl: ({ sourcePath, sourceId, fullPath }) => {
            const pathPart = sanitizeCtPath(sourcePath || fullPath || '');
            if (pathPart) {
                return `https://character-tavern.com/character/${pathPart}`;
            }
            const idPart = sanitizeCtPath(sourceId || '');
            if (idPart) {
                return `https://character-tavern.com/character/${idPart}`;
            }
            return '';
        }
    },
    risuai: {
        domain: 'risuai.net',
        buildUrl: ({ sourceId }) => sourceId ? `https://realm.risuai.net/character/${sourceId}` : ''
    },
    wyvern: {
        domain: 'wyvern.chat',
        buildUrl: ({ sourceId }) => sourceId ? `https://app.wyvern.chat/characters/${sourceId}` : ''
    },
    chub: {
        domain: 'chub.ai',
        buildUrl: ({ fullPath }) => fullPath ? `https://chub.ai/characters/${fullPath}` : ''
    }
};

function resolveSourceUrlValue({ source, sourceUrl, sourcePath, sourceId, fullPath } = {}) {
    const config = SOURCE_URL_CONFIG[source];

    if (config) {
        // Check if existing sourceUrl matches the expected domain
        if (sourceUrl && sourceUrl.includes(config.domain)) {
            return sourceUrl;
        }
        // Build URL from source-specific logic
        const builtUrl = config.buildUrl({ sourcePath, sourceId, fullPath });
        if (builtUrl) {
            return builtUrl;
        }
    }

    // Fallback: use provided sourceUrl or default to chub
    if (sourceUrl) {
        return sourceUrl;
    }
    if (fullPath) {
        return `https://chub.ai/characters/${fullPath}`;
    }
    return '';
}

function rowToCard(row) {
    const cardId = String(row.id);
    const topicsArray = row.topics ? row.topics.split(',') : [];
    const uniqueTopics = [...new Set(topicsArray)];
    const versionedImage = buildVersionedImagePath(cardId);

    return {
        id: cardId,
        id_prefix: cardId.substring(0, 2),
        author: row.author || '',
        name: row.name || '',
        tagline: row.tagline || '',
        description: row.description || '',
        topics: uniqueTopics,
        imagePath: versionedImage.path,
        imageVersion: versionedImage.version,
        tokenCount: row.tokenCount || 0,
        lastModified: row.lastModified ? row.lastModified.split(' ')[0] : 'Unknown',
        createdAt: row.createdAt ? row.createdAt.split(' ')[0] : 'Unknown',
        nChats: row.nChats || 0,
        nMessages: row.nMessages || 0,
        n_favorites: row.n_favorites || 0,
        starCount: row.starCount || 0,
        rating: row.rating || 0,
        ratingCount: row.ratingCount || 0,
        ratings: row.ratings || '{}',
        fullPath: row.fullPath || '',
        language: row.language || 'unknown',
        favorited: row.favorited || 0,
        visibility: row.visibility || 'unknown',
        hasAlternateGreetings: !!row.hasAlternateGreetings,
        hasLorebook: !!row.hasLorebook,
        hasEmbeddedLorebook: !!row.hasEmbeddedLorebook,
        hasLinkedLorebook: !!row.hasLinkedLorebook,
        hasExampleDialogues: !!row.hasExampleDialogues,
        hasSystemPrompt: !!row.hasSystemPrompt,
        hasGallery: !!row.hasGallery,
        hasEmbeddedImages: !!row.hasEmbeddedImages,
        hasExpressions: !!row.hasExpressions,
        source: row.source || 'chub',
        sourceId: row.sourceId || '',
        sourcePath: row.sourcePath || row.fullPath || '',
        sourceUrl: resolveSourceUrlValue({
            source: row.source || 'chub',
            sourceUrl: row.sourceUrl,
            sourcePath: row.sourcePath || row.fullPath || '',
            sourceId: row.sourceId || '',
            fullPath: row.fullPath || ''
        })
    };
}

export function detectLanguage(text, threshold = 0.8, minLength = 20) {
    try {
        if (!text || text.trim().length < minLength) {
            return 'unknown';
        }
        const langCode = franc(text, { minLength: 10 });
        return langCode === 'und' ? 'unknown' : langCode;
    } catch (error) {
        log.error('Language detection failed', error);
        return 'unknown';
    }
}

export function upsertCard(metadata) {
    const database = getDbInstance();

    const topicsArray = Array.isArray(metadata.topics)
        ? metadata.topics
        : splitTopicsToArray(metadata.topics || '');
    const topics = Array.isArray(metadata.topics) ? metadata.topics.join(',') : metadata.topics || '';
    const author = metadata.author || (metadata.fullPath ? metadata.fullPath.split('/')[0] : '');
    const combinedText = `${metadata.description || ''} ${metadata.tagline || ''}`;
    const language = detectLanguage(combinedText);

    let favoritedValue = 0;
    let firstDownloadedAt = null;

    const columns = database.prepare(`PRAGMA table_info(cards)`).all();
    const hasFirstDownloadedAt = columns.some(col => col.name === 'firstDownloadedAt');

    const selectFields = hasFirstDownloadedAt
        ? 'SELECT favorited, firstDownloadedAt FROM cards WHERE id = ?'
        : 'SELECT favorited FROM cards WHERE id = ?';

    const existing = database.prepare(selectFields).get(metadata.id);
    if (existing) {
        favoritedValue = existing.favorited ? 1 : 0;
        if (hasFirstDownloadedAt && existing.firstDownloadedAt) {
            firstDownloadedAt = existing.firstDownloadedAt;
        } else {
            firstDownloadedAt = new Date().toISOString();
        }
    } else {
        firstDownloadedAt = new Date().toISOString();

        if (typeof metadata.favorited !== 'undefined') {
            favoritedValue = metadata.favorited ? 1 : 0;
        } else if (typeof metadata.is_favorite !== 'undefined') {
            favoritedValue = metadata.is_favorite ? 1 : 0;
        }
    }

    const baseColumns = [
        'id', 'author', 'name', 'tagline', 'description', 'topics', 'tokenCount',
        'tokenDescriptionCount', 'tokenPersonalityCount', 'tokenScenarioCount',
        'tokenMesExampleCount', 'tokenFirstMessageCount', 'tokenSystemPromptCount',
        'tokenPostHistoryCount', 'lastModified', 'createdAt'
    ];

    if (hasFirstDownloadedAt) {
        baseColumns.push('firstDownloadedAt');
    }

    baseColumns.push(
        'nChats', 'nMessages', 'n_favorites',
        'starCount', 'ratingsEnabled', 'rating', 'ratingCount', 'ratings',
        'fullPath', 'favorited', 'language', 'visibility',
        'hasAlternateGreetings', 'hasLorebook', 'hasEmbeddedLorebook', 'hasLinkedLorebook',
        'hasExampleDialogues', 'hasSystemPrompt', 'hasGallery', 'hasEmbeddedImages', 'hasExpressions', 'isFuzzed',
        'source', 'sourceId', 'sourcePath', 'sourceUrl'
    );

    const columnsClause = baseColumns.join(', ');
    const placeholdersClause = baseColumns.map(() => '?').join(', ');

    const updateClause = baseColumns
        .filter(column => column !== 'id')
        .map(column => `${column} = excluded.${column}`)
        .join(', ');
    const sql = `
        INSERT INTO cards (${columnsClause}) VALUES (${placeholdersClause})
        ON CONFLICT(id) DO UPDATE SET ${updateClause}
    `;
    
    const computedSourceUrl = resolveSourceUrlValue({
        source: metadata.source || 'chub',
        sourceUrl: metadata.sourceUrl,
        sourcePath: metadata.sourcePath || metadata.fullPath || '',
        sourceId: metadata.sourceId || String(metadata.id || ''),
        fullPath: metadata.fullPath || ''
    });

    const params = [
        metadata.id,
        author,
        metadata.name || '',
        metadata.tagline || '',
        metadata.description || '',
        topics,
        metadata.nTokens || 0,
        metadata.tokenDescriptionCount ?? null,
        metadata.tokenPersonalityCount ?? null,
        metadata.tokenScenarioCount ?? null,
        metadata.tokenMesExampleCount ?? null,
        metadata.tokenFirstMessageCount ?? null,
        metadata.tokenSystemPromptCount ?? null,
        metadata.tokenPostHistoryCount ?? null,
        (metadata.lastActivityAt || metadata.lastModified || '1970-01-01T00:00:00').replace('T', ' ').split('.')[0],
        (metadata.createdAt || '1970-01-01T00:00:00').replace('T', ' ').split('.')[0]
    ];

    if (hasFirstDownloadedAt) {
        params.push(firstDownloadedAt);
    }

    params.push(
        metadata.nChats || 0,
        metadata.nMessages || 0,
        metadata.n_favorites || 0,
        metadata.starCount || 0,
        metadata.ratingsEnabled ? 1 : 0,
        metadata.rating || 0.0,
        metadata.ratingCount || 0,
        metadata.ratings || '{}',
        metadata.fullPath || '',
        favoritedValue,
        language,
        metadata.visibility || 'unknown',
        metadata.hasAlternateGreetings ? 1 : 0,
        metadata.hasLorebook ? 1 : 0,
        metadata.hasEmbeddedLorebook ? 1 : 0,
        metadata.hasLinkedLorebook ? 1 : 0,
        metadata.hasExampleDialogues ? 1 : 0,
        metadata.hasSystemPrompt ? 1 : 0,
        metadata.hasGallery ? 1 : 0,
        metadata.hasEmbeddedImages ? 1 : 0,
        metadata.hasExpressions ? 1 : 0,
        metadata.isFuzzed ? 1 : 0,
        metadata.source || 'chub',
        metadata.sourceId || String(metadata.id),
        metadata.sourcePath || metadata.fullPath || '',
        computedSourceUrl
    );

    log.debug(`Upserting card ${metadata.id}: stars=${metadata.starCount}, favs=${metadata.n_favorites}, rating=${metadata.rating}, lastModified=${params[14]}`);

    withTransaction((db) => {
        db.prepare(sql).run(...params);
        replaceCardTagsForDatabase(db, metadata.id, topicsArray);
    });

    log.debug(`Card ${metadata.id} upserted successfully`);
}

export function getCards(options = {}) {
    const {
        page = 1,
        limit = CARDS_PER_PAGE,
        query = '',
        includeQuery = '',
        excludeQuery = '',
        searchType = 'full',
        tagMatchMode = 'or',
        sort = 'new',
        source = 'all',
        language = null,
        favoriteFilter = null,
        hasAlternateGreetings = false,
        hasLorebook = false,
        hasEmbeddedLorebook = false,
        hasLinkedLorebook = false,
        hasExampleDialogues = false,
        hasSystemPrompt = false,
        hasGallery = false,
        hasEmbeddedImages = false,
        hasExpressions = false,
        allowedIds = null,
        followedOnly = false,
        followedCreators = [],
        minTokens = null
    } = options;
    
    const database = getDbInstance();
    const offset = (page - 1) * limit;

    const allowedIdList = Array.isArray(allowedIds) ? allowedIds.filter(Boolean) : null;
    if (allowedIds !== null && allowedIdList.length === 0) {
        return {
            cards: [],
            count: 0,
            page,
            totalPages: 0
        };
    }
    
    let sql = 'SELECT * FROM cards WHERE 1=1';
    let countSql = 'SELECT COUNT(*) as count FROM cards WHERE 1=1';
    const params = [];
    const countParams = [];
    
    const parseTagList = (value) => value
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);

    const includeFilterTags = includeQuery
        ? parseTagList(includeQuery)
        : [];
    const includeSearchTags = (searchType === 'tag' && query)
        ? parseTagList(query)
        : [];
    const includeTags = Array.from(new Set([...includeFilterTags, ...includeSearchTags]));
    const excludeTags = excludeQuery
        ? parseTagList(excludeQuery)
        : [];

    const buildVariantGroups = (list) => list
        .map(tag => {
            const variants = new Set();
            const addVariant = (value) => {
                const normalized = normalizeTagValue(value);
                if (normalized) {
                    variants.add(normalized);
                }
            };
            addVariant(tag);
            expandTagSearch(tag).forEach(addVariant);
            return Array.from(variants);
        })
        .filter(group => group.length > 0);

    const includeGroups = buildVariantGroups(includeTags);
    const excludeGroups = buildVariantGroups(excludeTags);

    const appendClause = (clause, clauseParams = []) => {
        if (!clause) {
            return;
        }
        sql += ` AND ${clause}`;
        countSql += ` AND ${clause}`;
        if (clauseParams.length > 0) {
            params.push(...clauseParams);
            countParams.push(...clauseParams);
        }
    };

    const buildExistsClause = (variants, negate = false) => {
        if (!variants || variants.length === 0) {
            return { clause: '', params: [] };
        }
        const placeholders = variants.map(() => '?').join(', ');
        const operator = negate ? 'NOT EXISTS' : 'EXISTS';
        const clause = `${operator} (SELECT 1 FROM ${CARD_TAGS_TABLE_NAME} ct WHERE ct.cardId = cards.id AND ct.normalizedTag IN (${placeholders}))`;
        return { clause, params: variants };
    };

    if (includeGroups.length > 0) {
        if (tagMatchMode === 'and') {
            includeGroups.forEach(group => {
                const { clause, params: clauseParams } = buildExistsClause(group, false);
                appendClause(clause, clauseParams);
            });
        } else {
            const flattened = Array.from(new Set(includeGroups.flat()));
            const { clause, params: clauseParams } = buildExistsClause(flattened, false);
            appendClause(clause, clauseParams);
        }
    }

    if (excludeGroups.length > 0) {
        excludeGroups.forEach(group => {
            const { clause, params: clauseParams } = buildExistsClause(group, true);
            appendClause(clause, clauseParams);
        });
    }

    if (query && searchType !== 'tag') {
        if (searchType === 'title') {
            sql += ' AND (name LIKE ?)';
            countSql += ' AND (name LIKE ?)';
            params.push(`%${query}%`);
            countParams.push(`%${query}%`);
        } else if (searchType === 'author') {
            sql += ' AND (author LIKE ?)';
            countSql += ' AND (author LIKE ?)';
            params.push(`%${query}%`);
            countParams.push(`%${query}%`);
        } else { // full text search
            sql += ' AND (name LIKE ? OR description LIKE ? OR tagline LIKE ? OR topics LIKE ? OR author LIKE ?)';
            countSql += ' AND (name LIKE ? OR description LIKE ? OR tagline LIKE ? OR topics LIKE ? OR author LIKE ?)';
            const searchPattern = `%${query}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
            countParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
        }
    }

    if (typeof minTokens === 'number' && Number.isFinite(minTokens) && minTokens > 0) {
        sql += ' AND tokenCount >= ?';
        countSql += ' AND tokenCount >= ?';
        params.push(minTokens);
        countParams.push(minTokens);
    }

    if (language) {
        sql += ' AND language = ?';
        countSql += ' AND language = ?';
        params.push(language);
        countParams.push(language);
    }

    if (source && source !== 'all') {
        sql += ' AND source = ?';
        countSql += ' AND source = ?';
        params.push(source);
        countParams.push(source);
    }
    
    if (favoriteFilter === 'fav') {
        sql += ' AND favorited = 1';
        countSql += ' AND favorited = 1';
    } else if (favoriteFilter === 'not_fav') {
        sql += ' AND (favorited IS NULL OR favorited = 0)';
        countSql += ' AND (favorited IS NULL OR favorited = 0)';
    } else if (favoriteFilter === 'shadowban') {
        sql += ' AND visibility = "shadowban"';
        countSql += ' AND visibility = "shadowban"';
    } else if (favoriteFilter === 'deleted') {
        sql += ' AND visibility = "deleted"';
        countSql += ' AND visibility = "deleted"';
    }

    if (hasAlternateGreetings) {
        sql += ' AND hasAlternateGreetings = 1';
        countSql += ' AND hasAlternateGreetings = 1';
    }

    if (hasLorebook) {
        sql += ' AND hasLorebook = 1';
        countSql += ' AND hasLorebook = 1';
    }

    if (hasEmbeddedLorebook) {
        sql += ' AND hasEmbeddedLorebook = 1';
        countSql += ' AND hasEmbeddedLorebook = 1';
    }

    if (hasLinkedLorebook) {
        sql += ' AND hasLinkedLorebook = 1';
        countSql += ' AND hasLinkedLorebook = 1';
    }

    if (hasExampleDialogues) {
        sql += ' AND hasExampleDialogues = 1';
        countSql += ' AND hasExampleDialogues = 1';
    }

    if (hasSystemPrompt) {
        sql += ' AND hasSystemPrompt = 1';
        countSql += ' AND hasSystemPrompt = 1';
    }

    if (hasGallery) {
        sql += ' AND hasGallery = 1';
        countSql += ' AND hasGallery = 1';
    }

    if (hasEmbeddedImages) {
        sql += ' AND hasEmbeddedImages = 1';
        countSql += ' AND hasEmbeddedImages = 1';
    }

    if (hasExpressions) {
        sql += ' AND hasExpressions = 1';
        countSql += ' AND hasExpressions = 1';
    }

    if (followedOnly) {
        const authorList = Array.isArray(followedCreators)
            ? followedCreators
                .map(name => (name || '').trim())
                .filter(Boolean)
            : [];
        if (authorList.length === 0) {
            return {
                cards: [],
                count: 0,
                page,
                totalPages: 0
            };
        }
        const placeholders = authorList.map(() => '?').join(', ');
        sql += ` AND LOWER(author) IN (${placeholders})`;
        countSql += ` AND LOWER(author) IN (${placeholders})`;
        authorList.forEach(author => {
            params.push(author.toLowerCase());
            countParams.push(author.toLowerCase());
        });
    }

    if (allowedIdList && allowedIdList.length > 0) {
        const placeholders = allowedIdList.map(() => '?').join(', ');
        sql += ` AND id IN (${placeholders})`;
        countSql += ` AND id IN (${placeholders})`;
        params.push(...allowedIdList);
        countParams.push(...allowedIdList);
    }
    
    const lastActivityExpr = `COALESCE(lastModified, createdAt, '1970-01-01 00:00:00')`;
    const activityAgeExpr = `MAX(1.0, julianday('now') - julianday(${lastActivityExpr}))`;
    const freshnessBonusExpr = `CASE
            WHEN julianday('now') - julianday(${lastActivityExpr}) <= 3 THEN 25.0
            WHEN julianday('now') - julianday(${lastActivityExpr}) <= 7 THEN 15.0
            WHEN julianday('now') - julianday(${lastActivityExpr}) <= 14 THEN 8.0
            ELSE 0.0
        END`;
    const ratingContributionExpr = `(MAX(0.0, CAST(COALESCE(rating, 0) AS REAL) - 3.0) * CAST(COALESCE(ratingCount, 0) AS REAL) * 0.2)`;
    const engagementScoreExpr = `((CAST(COALESCE(nChats, 0) AS REAL) * 1.5) + (CAST(COALESCE(nMessages, 0) AS REAL) * 0.1) + (CAST(COALESCE(n_favorites, 0) AS REAL) * 2.0) + (CAST(COALESCE(starCount, 0) AS REAL) * 0.5) + ${ratingContributionExpr} + ${freshnessBonusExpr})`;

    const sortMap = {
        'new': 'lastModified DESC',
        'old': 'lastModified ASC',
        'create_new': 'createdAt DESC',
        'create_old': 'createdAt ASC',
        'recently_added': 'firstDownloadedAt DESC',
        'oldest_added': 'firstDownloadedAt ASC',
        'tokens_desc': 'tokenCount DESC',
        'tokens_asc': 'tokenCount ASC',
        'most_stars_desc': 'starCount DESC',
        'most_stars_asc': 'starCount ASC',
        'most_favs_desc': 'n_favorites DESC',
        'most_favs_asc': 'n_favorites ASC',
        'most_msgs_desc': 'nMessages DESC',
        'most_msgs_asc': 'nMessages ASC',
        'most_chats_desc': 'nChats DESC',
        'most_chats_asc': 'nChats ASC',
        'overall_rating_desc': '(CAST(COALESCE(starCount, 0) AS REAL) * 1.0 + CAST(COALESCE(n_favorites, 0) AS REAL) * 2.0) DESC, id DESC',
        'overall_rating_asc': '(CAST(COALESCE(starCount, 0) AS REAL) * 1.0 + CAST(COALESCE(n_favorites, 0) AS REAL) * 2.0) ASC, id ASC',
        'trending_desc': '((CAST(COALESCE(starCount, 0) AS REAL) * 1.0 + CAST(COALESCE(n_favorites, 0) AS REAL) * 2.0) / MAX(1.0, julianday(\'now\') - julianday(createdAt))) DESC, id DESC',
        'trending_asc': '((CAST(COALESCE(starCount, 0) AS REAL) * 1.0 + CAST(COALESCE(n_favorites, 0) AS REAL) * 2.0) / MAX(1.0, julianday(\'now\') - julianday(createdAt))) ASC, id ASC',
        'engagement_desc': `${engagementScoreExpr} DESC, id DESC`,
        'engagement_asc': `${engagementScoreExpr} ASC, id ASC`,
        'fresh_engagement_desc': `(${engagementScoreExpr} / ${activityAgeExpr}) DESC, id DESC`,
        'fresh_engagement_asc': `(${engagementScoreExpr} / ${activityAgeExpr}) ASC, id ASC`
    };

    const orderBy = sortMap[sort] || sortMap.new;
    log.debug(`Sort param: "${sort}", Using ORDER BY: ${orderBy}`);
    sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const countResult = database.prepare(countSql).all(...countParams);
    const cards = database.prepare(sql).all(...params);

    if (sort === 'overall_rating_desc' && cards.length > 0) {
        log.debug('Top 3 results for overall_rating_desc:');
        cards.slice(0, 3).forEach(card => {
            const score = (card.starCount || 0) * 1.0 + (card.n_favorites || 0) * 2.0;
            log.debug(`  ${card.name}: stars=${card.starCount}, favs=${card.n_favorites}, score=${score}`);
        });
    }

    return {
        cards: cards.map(rowToCard),
        count: countResult[0].count,
        page,
        totalPages: Math.ceil(countResult[0].count / limit)
    };
}

export function getCardsByIdsOrdered(idList = []) {
    if (!Array.isArray(idList) || idList.length === 0) {
        return [];
    }
    const normalized = idList
        .map(id => String(id).trim())
        .filter(id => id && /^\d+$/.test(id));

    if (normalized.length === 0) {
        return [];
    }

    const uniqueIds = Array.from(new Set(normalized));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const database = getDbInstance();
    const rows = database.prepare(`SELECT * FROM cards WHERE id IN (${placeholders})`).all(...uniqueIds);
    const rowMap = new Map();
    rows.forEach(row => {
        rowMap.set(String(row.id), row);
    });

    return normalized
        .map(id => rowMap.get(id))
        .filter(Boolean)
        .map(rowToCard);
}

export function getAllLanguages() {
    const database = getDbInstance();
    const rows = database.prepare('SELECT DISTINCT language FROM cards WHERE language IS NOT NULL').all();

    const result = {};
    rows.forEach(row => {
        result[row.language] = LANGUAGE_MAPPING[row.language] || row.language;
    });

    return result;
}

export function toggleFavorite(cardId) {
    const database = getDbInstance();
    const card = database.prepare('SELECT favorited FROM cards WHERE id = ?').get(cardId);

    if (!card) {
        return { success: false, message: 'Card not found' };
    }

    const newStatus = card.favorited ? 0 : 1;
    database.prepare('UPDATE cards SET favorited = ? WHERE id = ?').run(newStatus, cardId);

    return { success: true, favorited: newStatus };
}

export function deleteCard(cardId) {
    const database = getDbInstance();
    const result = database.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
    log.info(`Deleted card ${cardId}`);
    return result;
}

async function readMetadataFile(cardId) {
    const cardIdStr = String(cardId);
    const subfolder = path.join(STATIC_DIR, cardIdStr.substring(0, 2));
    const jsonPath = path.join(subfolder, `${cardIdStr}.json`);
    try {
        const raw = await fsp.readFile(jsonPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function backfillTokenCounts(databaseConn) {
    if (!TOKEN_COUNT_COLUMNS.length) {
        return;
    }
    const nullChecks = TOKEN_COUNT_COLUMNS.map(column => `${column} IS NULL`).join(' OR ');
    const limit = 250;
    let processed = 0;
    let cursor = 0;

    try {
        const selectStmt = databaseConn.prepare(`
            SELECT id FROM cards
            WHERE id > ? AND source = 'chub' AND (${nullChecks})
            ORDER BY id ASC
            LIMIT ?
        `);
        const updateStmt = databaseConn.prepare(`UPDATE cards
            SET tokenDescriptionCount = ?,
                tokenPersonalityCount = ?,
                tokenScenarioCount = ?,
                tokenMesExampleCount = ?,
                tokenFirstMessageCount = ?,
                tokenSystemPromptCount = ?,
                tokenPostHistoryCount = ?
            WHERE id = ?`);

        while (true) {
            const rows = selectStmt.all(cursor, limit);
            if (!rows.length) {
                break;
            }
            for (const row of rows) {
                cursor = row.id;
                const metadata = await readMetadataFile(row.id);
                if (!metadata) {
                    continue;
                }
                const counts = resolveTokenCountsFromMetadata(metadata);
                if (!counts) {
                    continue;
                }
                updateStmt.run(
                    counts.tokenDescriptionCount ?? 0,
                    counts.tokenPersonalityCount ?? 0,
                    counts.tokenScenarioCount ?? 0,
                    counts.tokenMesExampleCount ?? 0,
                    counts.tokenFirstMessageCount ?? 0,
                    counts.tokenSystemPromptCount ?? 0,
                    counts.tokenPostHistoryCount ?? 0,
                    row.id
                );
                processed += 1;
            }
        }
        if (processed > 0) {
            log.info(`Backfilled token counts for ${processed} card(s)`);
        }
    } catch (error) {
        log.warn('Failed to backfill token counts', error);
    }
}
