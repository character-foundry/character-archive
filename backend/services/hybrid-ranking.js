function unique(values) {
    return [...new Set((values || []).map(String))];
}

export function fuseHybridSearchIds({
    vectorIds = [],
    lexicalIds = [],
    semanticRatio = 0.5,
    rrfK = 60
} = {}) {
    const vectors = unique(vectorIds);
    const lexical = unique(lexicalIds);
    const ratio = Math.min(1, Math.max(0, Number(semanticRatio)));
    if (ratio === 1) return vectors;
    if (ratio === 0) return lexical;
    const k = Math.max(1, Number(rrfK) || 60);
    const scores = new Map();
    const firstSeen = new Map();
    let sequence = 0;
    const contribute = (ids, weight) => {
        ids.forEach((id, index) => {
            if (!firstSeen.has(id)) firstSeen.set(id, sequence++);
            scores.set(id, (scores.get(id) || 0) + weight / (k + index + 1));
        });
    };
    contribute(vectors, ratio);
    contribute(lexical, 1 - ratio);
    return [...scores.keys()].sort((left, right) => (
        scores.get(right) - scores.get(left)
        || firstSeen.get(left) - firstSeen.get(right)
    ));
}

export function prioritizeLiteralTitleMatches(ids = [], cards = [], query = '') {
    const rawQuery = String(query || '').trim();
    if (!rawQuery || /\b(?:AND|OR|NOT)\b|[()]/i.test(rawQuery)) return [...ids];
    const normalizedQuery = rawQuery
        .replace(/^"|"$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!normalizedQuery) return [...ids];
    const tokens = normalizedQuery.split(' ').filter(Boolean);
    const nameById = new Map(cards.map(card => [String(card.id), String(card.name || '').trim().toLowerCase()]));
    const priority = id => {
        const name = nameById.get(String(id)) || '';
        if (name === normalizedQuery) return 0;
        if (name.includes(normalizedQuery)) return 1;
        if (tokens.length > 1 && tokens.every(token => name.includes(token))) return 2;
        return 3;
    };
    return [...ids]
        .map((id, index) => ({ id: String(id), index, priority: priority(id) }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map(item => item.id);
}
