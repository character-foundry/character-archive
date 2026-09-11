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
        if (rest[0] === ':') {
            tokens.push({ type: 'colon', value: ':' });
            index += 1;
            continue;
        }
        if (rest[0] === '(' || rest[0] === ')') {
            tokens.push({ type: 'paren', value: rest[0] });
            index += 1;
            continue;
        }
        if (rest[0] === '[' || rest[0] === ']' || rest[0] === ',') {
            tokens.push({ type: 'list', value: rest[0] });
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
        const number = rest.match(/^-?\d+(?:\.\d+)?(?=$|[\s(),\[\]<>!=])/);
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
            } else if (upper === 'IN' || upper === 'EXISTS') {
                tokens.push({ type: 'operator', value: upper });
            } else if (upper === 'TO') {
                tokens.push({ type: 'range-operator', value: upper });
            } else if (upper === 'TRUE' || upper === 'FALSE') {
                tokens.push({ type: 'boolean', value: upper === 'TRUE' });
            } else {
                tokens.push({ type: 'identifier', value: word[0] });
            }
            index += word[0].length;
            continue;
        }
        const bare = rest.match(/^[^\s()=<>!,\[\]:]+/);
        if (bare) {
            tokens.push({ type: 'identifier', value: bare[0] });
            index += bare[0].length;
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
    const isValue = token => Boolean(
        token && ['literal', 'number', 'boolean', 'identifier'].includes(token.type)
    );
    const literalValue = token => token.type === 'identifier' ? { ...token, type: 'literal' } : token;

    function parseList(field) {
        if (take()?.value !== '[') {
            throw new Error('Expected a list after ' + field + ' IN');
        }
        const values = [];
        while (true) {
            const value = take();
            if (!isValue(value)) {
                throw new Error('Expected a value in ' + field + ' IN list');
            }
            values.push(literalValue(value));
            const separator = peek();
            if (separator?.type === 'list' && separator.value === ',') {
                take();
                continue;
            }
            if (separator?.type === 'list' && separator.value === ']') {
                take();
                break;
            }
            throw new Error('Expected a comma or closing list after ' + field + ' IN value');
        }
        return values;
    }

    function parseComparison() {
        const field = take();
        if (!field || field.type !== 'identifier') {
            throw new Error('Expected a search filter field');
        }
        if (!FILTERABLE_FIELDS.has(field.value)) {
            throw new Error(`Unsupported search filter field: ${field.value}`);
        }
        const firstValue = peek();
        if (isValue(firstValue) && tokens[cursor + 1]?.type === 'range-operator') {
            take();
            take();
            const maximum = take();
            if (!isValue(maximum)) {
                throw new Error('Expected a value after ' + field.value + ' TO');
            }
            return {
                type: 'range',
                field: FIELD_ALIASES[field.value] || field.value,
                minimum: literalValue(firstValue),
                maximum: literalValue(maximum)
            };
        }
        const operator = take();
        if (operator?.type === 'colon') {
            const value = take();
            if (!value || !['literal', 'number', 'boolean', 'identifier'].includes(value.type)) {
                throw new Error(`Expected a value after ${field.value}:`);
            }
            return {
                type: 'comparison',
                field: FIELD_ALIASES[field.value] || field.value,
                operator: '=',
                value: value.type === 'identifier' ? { ...value, type: 'literal' } : value
            };
        }
        if (operator?.type === 'boolean-operator' && operator.value === 'NOT') {
            const next = peek();
            if (next?.type === 'operator' && next.value === 'IN') {
                take();
                return {
                    type: 'not',
                    value: {
                        type: 'in',
                        field: FIELD_ALIASES[field.value] || field.value,
                        values: parseList(field.value)
                    }
                };
            }
            if (next?.type === 'operator' && next.value === 'EXISTS') {
                take();
                return {
                    type: 'not',
                    value: {
                        type: 'exists',
                        field: FIELD_ALIASES[field.value] || field.value
                    }
                };
            }
        }
        if (!operator || operator.type !== 'operator') {
            throw new Error(`Expected a comparison operator or colon after ${field.value}`);
        }

        if (operator.value === 'IN') {
            if (take()?.value !== '[') {
                throw new Error(`Expected a list after ${field.value} IN`);
            }
            const values = [];
            while (true) {
                const value = take();
                if (!value || !['literal', 'number', 'boolean', 'identifier'].includes(value.type)) {
                    throw new Error(`Expected a value in ${field.value} IN list`);
                }
                values.push(value.type === 'identifier' ? { ...value, type: 'literal' } : value);
                const separator = peek();
                if (separator?.type === 'list' && separator.value === ',') {
                    take();
                    continue;
                }
                if (separator?.type === 'list' && separator.value === ']') {
                    take();
                    break;
                }
                throw new Error(`Expected a comma or closing list after ${field.value} IN value`);
            }
            return {
                type: 'in',
                field: FIELD_ALIASES[field.value] || field.value,
                values
            };
        }
        if (operator.value === 'EXISTS') {
            return {
                type: 'exists',
                field: FIELD_ALIASES[field.value] || field.value
            };
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
    const rawValue = String(token.value);
    const normalizedValue = STRING_FIELDS.has(field) || field === 'tags' || field === 'topics'
        ? rawValue.toLowerCase()
        : rawValue;
    if (STRING_FIELDS.has(field) || field === 'tags' || field === 'topics') {
        return `'${normalizedValue.replaceAll("'", "''")}'`;
    }
    if (token.type === 'number') return String(token.value);
    if (token.type === 'boolean') return token.value ? 'true' : 'false';
    return `'${normalizedValue.replaceAll("'", "''")}'`;
}

function compile(node) {
    if (node.type === 'binary') {
        return `(${compile(node.left)}) ${node.operator} (${compile(node.right)})`;
    }
    if (node.type === 'not') return `NOT (${compile(node.value)})`;
    if (node.type === 'exists') return node.field + ' IS NOT NULL';
    if (node.type === 'range') {
        const fieldExpression = STRING_FIELDS.has(node.field) ? 'LOWER(' + node.field + ')' : node.field;
        return '(' + fieldExpression + ' >= ' + sqlValue(node.minimum, node.field)
            + ') AND (' + fieldExpression + ' <= ' + sqlValue(node.maximum, node.field) + ')';
    }
    if (node.type === 'in') {
        if (!node.values.length) throw new Error(`Search filter IN lists cannot be empty for ${node.field}`);
        if (node.field === 'tags' || node.field === 'topics') {
            return `(${node.values.map(item => `array_contains(${node.field}, ${sqlValue(item, node.field)})`).join(' OR ')})`;
        }
        const fieldExpression = STRING_FIELDS.has(node.field) ? `LOWER(${node.field})` : node.field;
        return `${fieldExpression} IN (${node.values.map(item => sqlValue(item, node.field)).join(', ')})`;
    }
    const value = sqlValue(node.value, node.field);
    if (node.field === 'tags' || node.field === 'topics') {
        if (node.operator === '=') return `array_contains(${node.field}, ${value})`;
        if (node.operator === '!=') return `NOT array_contains(${node.field}, ${value})`;
        throw new Error(`Unsupported operator ${node.operator} for ${node.field}`);
    }
    const fieldExpression = STRING_FIELDS.has(node.field) && ['=', '!='].includes(node.operator)
        ? `LOWER(${node.field})`
        : node.field;
    return `${fieldExpression} ${node.operator} ${value}`;
}

export function compileLanceFilter(rawFilter = '') {
    const normalized = typeof rawFilter === 'string' ? rawFilter.trim() : '';
    if (!normalized) return '';
    return compile(parse(tokenize(normalized)));
}

export const LANCE_FILTERABLE_FIELDS = Object.freeze([...FILTERABLE_FIELDS]);
