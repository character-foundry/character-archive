const OPERATOR = /^(AND|OR|NOT)$/i;

export function hasBooleanSyntax(value) {
    return /(?:\b(?:AND|OR|NOT)\b|[()])/i.test(String(value || ''));
}

export function hasExactPhraseSyntax(value) {
    return /"(?:\\.|[^"\\])+"/.test(String(value || ''));
}

function tokenize(value) {
    return String(value || '').match(/"(?:\\.|[^"\\])*"|\(|\)|\bAND\b|\bOR\b|\bNOT\b|[^\s()]+/gi) || [];
}

function isOperandStart(token) {
    return Boolean(token && (token === '(' || token === 'NOT' || !['AND', 'OR', ')'].includes(token)));
}

export function parseBooleanQuery(value) {
    const text = String(value || '').trim();
    if (!text || !hasBooleanSyntax(text)) return null;
    const tokens = tokenize(text).map(token => OPERATOR.test(token) ? token.toUpperCase() : token);
    let index = 0;

    const parsePrimary = () => {
        const token = tokens[index++];
        if (!token) throw new Error('Boolean search ended before an operand');
        if (token === '(') {
            const expression = parseOr();
            if (tokens[index++] !== ')') throw new Error('Boolean search is missing a closing parenthesis');
            return expression;
        }
        if (['AND', 'OR', ')'].includes(token)) throw new Error(`Boolean search expected a term before ${token}`);
        return { type: 'term', value: token };
    };

    const parseUnary = () => {
        if (tokens[index] === 'NOT') {
            index++;
            return { type: 'not', child: parseUnary() };
        }
        return parsePrimary();
    };

    const parseAnd = () => {
        let node = parseUnary();
        while (tokens[index] === 'AND' || isOperandStart(tokens[index])) {
            if (tokens[index] === 'AND') index++;
            node = { type: 'and', left: node, right: parseUnary() };
        }
        return node;
    };

    const parseOr = () => {
        let node = parseAnd();
        while (tokens[index] === 'OR') {
            index++;
            node = { type: 'or', left: node, right: parseAnd() };
        }
        return node;
    };

    const ast = parseOr();
    if (index !== tokens.length) throw new Error(`Boolean search could not parse token ${tokens[index]}`);
    return ast;
}

export async function evaluateBooleanQuery(ast, { searchTerm, allIds }) {
    const termCache = new Map();
    let universe = null;
    const terms = async value => {
        if (!termCache.has(value)) termCache.set(value, Promise.resolve(searchTerm(value)));
        return termCache.get(value);
    };
    const everyId = async () => {
        if (!universe) universe = Promise.resolve(allIds());
        return universe;
    };
    const evaluate = async node => {
        if (node.type === 'term') return new Map(await terms(node.value));
        if (node.type === 'not') {
            const [all, excluded] = await Promise.all([everyId(), evaluate(node.child)]);
            const result = new Map(all.map(id => [String(id), 0]));
            for (const id of excluded.keys()) result.delete(String(id));
            return result;
        }
        const [left, right] = await Promise.all([evaluate(node.left), evaluate(node.right)]);
        if (node.type === 'and') {
            const result = new Map();
            for (const [id, score] of left) {
                if (right.has(id)) result.set(id, score + right.get(id));
            }
            return result;
        }
        const result = new Map(left);
        for (const [id, score] of right) result.set(id, (result.get(id) || 0) + score);
        return result;
    };
    return evaluate(ast);
}
