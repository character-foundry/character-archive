const FIELD_ALIASES = Object.freeze({
    platformSummary: 'platform_summary',
    token_count: 'tokenCount'
});

const FILTERABLE_FIELDS = new Set([
    'id', 'source', 'sourceId', 'sourcePath', 'name', 'author', 'tagline',
    'description', 'platform_summary', 'platformSummary', 'tags', 'topics',
    'type', 'language', 'visibility', 'favorited', 'hasAlternateGreetings',
    'hasLorebook', 'hasEmbeddedLorebook', 'hasLinkedLorebook',
    'hasExampleDialogues', 'hasSystemPrompt', 'hasGallery',
    'hasEmbeddedImages', 'hasExpressions', 'tokenCount', 'token_count',
    'rating', 'ratingCount', 'starCount', 'n_favorites', 'favorites',
    'nChats', 'nMessages', 'tokenDescriptionCount', 'tokenPersonalityCount',
    'tokenScenarioCount', 'tokenMesExampleCount', 'tokenFirstMessageCount',
    'tokenSystemPromptCount', 'tokenPostHistoryCount', 'created', 'createdAt',
    'added', 'updated', 'lastModified', 'fullPath', 'scoreComposite',
    'scoreVelocity', 'engagementScore', 'engagementVelocity'
]);
const STRING_FIELDS = new Set([
    'id', 'source', 'sourceId', 'sourcePath', 'name', 'author', 'tagline',
    'description', 'platform_summary', 'platformSummary', 'type', 'language',
    'visibility', 'created', 'createdAt', 'added', 'updated', 'lastModified',
    'fullPath'
]);

function normalizeColonSyntax(expression) {
    return expression.replace(
        /(\b[a-zA-Z_][\w]*)\s*:\s*("[^"]*"|'[^']*'|[^\s()]+)/g,
        (match, field, value) => {
            const alreadyQuoted = (value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"));
            const scalar = /^-?\d+(?:\.\d+)?$/.test(value) || /^(true|false)$/i.test(value);
            return `${field} = ${alreadyQuoted || scalar ? value : JSON.stringify(value)}`;
        }
    );
}

function tokenize(expression) {
    const tokens = [];
    let index = 0;
    while (index < expression.length) {
        const rest = expression.slice(index);
        const whitespace = rest.match(/^\s+/);
        if (whitespace) {
            index += whitespace[0].length;
            continue;
        }
        const operator = rest.match(/^(>=|<=|!=|=|>|<)/);
        if (operator) {
            tokens.push({ type: 'operator', value: operator[0] });
            index += operator[0].length;
            continue;
        }
        if (rest[0] === '(' || rest[0] === ')') {
            tokens.push({ type: 'paren', value: rest[0] });
            index += 1;
            continue;
        }
        if (rest[0] === '"' || rest[0] === "'") {
            const quote = rest[0];
            let value = '';
            let closed = false;
            let cursor = 1;
            for (; cursor < rest.length; cursor += 1) {
                const character = rest[cursor];
                if (character === '\\' && cursor + 1 < rest.length) {
                    value += rest[cursor + 1];
                    cursor += 1;
                } else if (character === quote) {
                    closed = true;
                    cursor += 1;
                    break;
                } else {
                    value += character;
                }
            }
            if (!closed) throw new Error('Unterminated quoted search filter value');
            tokens.push({ type: 'literal', value });
            index += cursor;
            continue;
        }
        const number = rest.match(/^-?\d+(?:\.\d+)?\b/);
        if (number) {
            tokens.push({ type: 'number', value: Number(number[0]) });
            index += number[0].length;
            continue;
        }
        const word = rest.match(/^[a-zA-Z_][\w.-]*/);
        if (word) {
            const upper = word[0].toUpperCase();
            if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
                tokens.push({ type: 'boolean-operator', value: upper });
            } else if (upper === 'TRUE' || upper === 'FALSE') {
                tokens.push({ type: 'boolean', value: upper === 'TRUE' });
            } else {
                tokens.push({ type: 'identifier', value: word[0] });
            }
            index += word[0].length;
            continue;
        }
        throw new Error(`Unsupported character in search filter at position ${index}`);
    }
    return tokens;
}

function parse(tokens) {
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = () => tokens[cursor++];

    function parseComparison() {
        const field = take();
        if (!field || field.type !== 'identifier') {
            throw new Error('Expected a search filter field');
        }
        if (!FILTERABLE_FIELDS.has(field.value)) {
            throw new Error(`Unsupported search filter field: ${field.value}`);
        }
        const operator = take();
        if (!operator || operator.type !== 'operator') {
            throw new Error(`Expected a comparison operator after ${field.value}`);
        }
        const value = take();
        if (!value || !['literal', 'number', 'boolean', 'identifier'].includes(value.type)) {
            throw new Error(`Expected a value after ${field.value} ${operator.value}`);
        }
        return {
            type: 'comparison',
            field: FIELD_ALIASES[field.value] || field.value,
            operator: operator.value,
            value: value.type === 'identifier' ? { ...value, type: 'literal' } : value
        };
    }

    function parsePrimary() {
        if (peek()?.type === 'paren' && peek().value === '(') {
            take();
            const expression = parseOr();
            if (take()?.value !== ')') throw new Error('Unbalanced search filter parentheses');
            return expression;
        }
        return parseComparison();
    }

    function parseUnary() {
        if (peek()?.type === 'boolean-operator' && peek().value === 'NOT') {
            take();
            return { type: 'not', value: parseUnary() };
        }
        return parsePrimary();
    }

    function parseAnd() {
        let left = parseUnary();
        while (peek()?.type === 'boolean-operator' && peek().value === 'AND') {
            take();
            left = { type: 'binary', operator: 'AND', left, right: parseUnary() };
        }
        return left;
    }

    function parseOr() {
        let left = parseAnd();
        while (peek()?.type === 'boolean-operator' && peek().value === 'OR') {
            take();
            left = { type: 'binary', operator: 'OR', left, right: parseAnd() };
        }
        return left;
    }

    const result = parseOr();
    if (cursor !== tokens.length) throw new Error('Unexpected trailing search filter input');
    return result;
}

function sqlValue(token, field) {
    if (STRING_FIELDS.has(field)) return `'${String(token.value).replaceAll("'", "''")}'`;
    if (token.type === 'number') return String(token.value);
    if (token.type === 'boolean') return token.value ? 'true' : 'false';
    return `'${String(token.value).replaceAll("'", "''")}'`;
}

function compile(node) {
    if (node.type === 'binary') {
        return `(${compile(node.left)}) ${node.operator} (${compile(node.right)})`;
    }
    if (node.type === 'not') return `NOT ${compile(node.value)}`;
    const value = sqlValue(node.value, node.field);
    if (node.field === 'tags' || node.field === 'topics') {
        if (node.operator === '=') return `array_contains(${node.field}, ${value})`;
        if (node.operator === '!=') return `NOT array_contains(${node.field}, ${value})`;
        throw new Error(`Unsupported operator ${node.operator} for ${node.field}`);
    }
    return `${node.field} ${node.operator} ${value}`;
}

export function compileLanceFilter(rawFilter = '') {
    const normalized = typeof rawFilter === 'string' ? normalizeColonSyntax(rawFilter.trim()) : '';
    if (!normalized) return '';
    return compile(parse(tokenize(normalized)));
}

export const LANCE_FILTERABLE_FIELDS = Object.freeze([...FILTERABLE_FIELDS]);
