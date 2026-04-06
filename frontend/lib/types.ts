export interface VectorMatch {
  section: string | null;
  text: string;
  chunkIndex?: number | null;
  startToken?: number | null;
  endToken?: number | null;
  score?: number | null;
}

export interface VectorMeta {
  enabled?: boolean;
  appliedFilter?: string;
  meta?: {
    semanticRatio?: number;
    cardsFetched?: number;
    chunksFetched?: number;
  };
  chunkMatches?: Record<string, VectorMatch>;
}

export interface Card {
  id: string;
  id_prefix: string;
  author: string;
  name: string;
  tagline: string;
  description: string;
  topics: string[];
  imagePath: string;
  tokenCount: number;
  tokenDescriptionCount?: number | null;
  tokenPersonalityCount?: number | null;
  tokenScenarioCount?: number | null;
  tokenMesExampleCount?: number | null;
  tokenFirstMessageCount?: number | null;
  tokenSystemPromptCount?: number | null;
  tokenPostHistoryCount?: number | null;
  lastModified: string;
  createdAt: string;
  nChats: number;
  nMessages: number;
  n_favorites: number;
  starCount: number;
  rating: number;
  ratingCount: number;
  ratings: string;
  fullPath: string;
  language: string;
  favorited: number;
  visibility: string;
  hasAlternateGreetings: boolean;
  hasLorebook: boolean;
  hasEmbeddedLorebook: boolean;
  hasLinkedLorebook: boolean;
  hasExampleDialogues: boolean;
  hasSystemPrompt: boolean;
  hasGallery: boolean;
  hasEmbeddedImages: boolean;
  hasExpressions: boolean;
  silly_link?: string;
  loadedInSillyTavern?: boolean;
  syncedToArchitect?: boolean;
  source: string;
  sourceId?: string;
  sourcePath?: string;
  sourceUrl?: string;
  vectorMatch?: VectorMatch | null;
}

export interface CardsResponse {
  cards: Card[];
  count: number;
  page: number;
  totalPages: number;
  advanced?: {
    enabled: boolean;
    mode?: string;
    query?: string;
    filter?: string;
    fallbackReason?: string;
  };
  vector?: VectorMeta | null;
}

export interface Config {
  autoUpdateInterval: number;
  autoUpdateMode: boolean;
  syncTagsMode: boolean;
  backupMode: boolean;
  port: number;
  ip: string;
  venus: boolean;
  syncLimit: number;
  pageLimit: number;
  startPage: number;
  cycle_topics: boolean;
  topic: string;
  excludeTopic: string;
  use_timeline: boolean;
  syncByNew: boolean;
  min_tokens: number;
  apikey: string;
  chubApiKey?: string;
  chubProfileName?: string;
  followedCreators: string[];
  syncFollowedCreators: boolean;
  followedCreatorsOnly: boolean;
  blockedCreators?: string[];
  publicBaseUrl?: string;
  sillyTavern?: {
    enabled: boolean;
    baseUrl: string;
    importEndpoint?: string;
    csrfToken?: string;
    sessionCookie?: string;
    extraHeaders?: Record<string, string>;
  };
  ctSync?: {
    enabled: boolean;
    intervalMinutes: number;
    pages: number;
    hitsPerPage: number;
    minTokens: number;
    maxTokens: number;
    bannedTags: string[];
    excludedWarnings: string[];
    bearerToken: string;
    cfClearance: string;
    session: string;
    allowedWarnings: string;
  };
  risuAiSync?: {
    enabled: boolean;
    pageLimit: number;
    forceUpdate?: boolean;
  };
  wyvernSync?: {
    enabled: boolean;
    pageLimit: number;
    itemsPerPage: number;
    rating: string;
    bearerToken: string;
  };
  meilisearch?: {
    enabled: boolean;
    host: string;
    apiKey: string;
    indexName: string;
  };
  vectorSearch?: {
    enabled: boolean;
    enableChunks?: boolean;
    cardsIndex: string;
    chunksIndex: string;
    embedModel: string;
    embedderName: string;
    embedDimensions: number;
    ollamaUrl: string;
    semanticRatio?: number;
    cardsMultiplier?: number;
    maxCardHits?: number;
    chunkLimit?: number;
    chunkWeight?: number;
    rrfK?: number;
  };
  characterArchitect?: {
    enabled?: boolean;
    url: string;
  };
}

export interface ChubFollow {
  username: string;
  userId: number | null;
  avatarUrl: string | null;
}

export interface ChubFollowsResponse {
  profile: string;
  creators: ChubFollow[];
}

export interface ChubBlockedUsersResponse {
  blockedUsers: string[];
}

export interface GalleryAsset {
  id: string;
  url: string;
  originalUrl: string;
  title: string;
  caption: string;
  order: number;
  thumbUrl?: string;
}

export interface CachedAsset {
  id: number;
  cardId: number;
  originalUrl: string;
  localPath: string;
  assetType: string;
  fileSize?: number;
  cachedAt: string;
  metadata?: string;
}

export interface CachedAssetsResponse {
  success: boolean;
  assets: CachedAsset[];
  error?: string;
}

export interface ToggleFavoriteResponse {
  success: boolean;
  favorited: number;
  hasGallery: boolean;
  gallery?: {
    success?: boolean;
    cached?: number;
    skipped?: number;
    failed?: number;
    total?: number;
    error?: string;
    message?: string;
    removed?: number;
  } | null;
}

// Federation Types
export interface FederationPlatform {
  id: number;
  platform: string;
  display_name: string;
  base_url: string | null;
  api_key: string | null;
  enabled: number;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncState {
  id: number;
  card_id: number;
  platform: string;
  platform_id: string | null;
  last_sync_at: string | null;
  local_hash: string | null;
  remote_hash: string | null;
  status: 'pending' | 'synced' | 'conflict' | 'error';
  error_message: string | null;
  display_name: string;
  base_url: string | null;
  enabled: number;
}

export interface ConnectionTestResult {
  connected: boolean;
  error?: string;
  data?: unknown;
}

export interface PushResult {
  success: boolean;
  remoteId?: string;
  filename?: string;
  error?: string;
}

export interface BulkPushResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    cardId: string;
    success: boolean;
    remoteId?: string;
    filename?: string;
    error?: string;
  }>;
}
