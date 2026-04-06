export const defaultSillyTavernState = {
    enabled: false,
    baseUrl: '',
    importEndpoint: '/api/content/importURL',
    csrfToken: '',
    sessionCookie: '',
    extraHeaders: {} as Record<string, string>,
};

export const defaultCtSyncState = {
    enabled: false,
    intervalMinutes: 180,
    pages: 3,
    hitsPerPage: 49,
    minTokens: 300,
    maxTokens: 900000,
    bannedTags: [
        'furry',
        'anthro',
        'beastiality',
        'scat',
        'guro',
        'pokemon',
        'vore',
        'bbw',
        'weight gain',
        'zoophilia',
        'my little pony',
        'mlp',
    ],
    excludedWarnings: ['underage'],
    bearerToken: '',
    cfClearance: '',
    session: '',
    allowedWarnings: '',
};

export const defaultVectorSearchState = {
    enabled: false,
    enableChunks: true,
    cardsIndex: 'cards_vsem',
    chunksIndex: 'card_chunks',
    embedModel: 'snowflake-arctic-embed2:latest',
    embedderName: 'arctic2-1024',
    embedDimensions: 1024,
    ollamaUrl: 'http://127.0.0.1:11434',
    semanticRatio: 0.4,
    cardsMultiplier: 2,
    maxCardHits: 200,
    chunkLimit: 60,
    chunkWeight: 0.6,
    rrfK: 60,
};

export const defaultWyvernSyncState = {
    enabled: false,
    pageLimit: 50,
    itemsPerPage: 50,
    rating: 'explicit',
    bearerToken: '',
};
