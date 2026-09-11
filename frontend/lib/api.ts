import { CardsResponse, Config, ToggleFavoriteResponse, GalleryAsset, CachedAssetsResponse, ChubFollowsResponse, ChubBlockedUsersResponse, FederationPlatform, SyncState, ConnectionTestResult, PushResult, BulkPushResult } from './types';

const API_BASE = '';

export interface TagAliasesResponse {
  aliases: Record<string, string[]>;
}

export async function fetchCards(params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<CardsResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.append(key, value.toString());
    }
  });
  
  const queryString = searchParams.toString();
  const url = `${API_BASE}/api/cards${queryString ? `?${queryString}` : ''}`;
  const res = await fetch(url, { cache: 'no-store', signal });
  
  if (!res.ok) {
    let message = 'Failed to fetch cards';
    try {
      const payload = await res.json() as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the generic message when the server does not return JSON.
    }
    throw new Error(message);
  }
  
  return res.json();
}

export async function fetchCardMetadata(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/metadata`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch card metadata');
  return res.json();
}

export async function fetchPngInfo(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/png-info`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch PNG info');
  return res.json();
}

export async function fetchCardGallery(cardId: string): Promise<{ success: boolean; assets: GalleryAsset[]; error?: string }> {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/gallery`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch gallery');
  return res.json();
}

export async function toggleFavorite(cardId: string): Promise<ToggleFavoriteResponse> {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/favorite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('Failed to toggle favorite');
  return res.json();
}

export async function deleteCard(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete card');
  return res.json();
}

export async function refreshCard(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/refresh`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to refresh card');
  return res.json();
}

interface PushCardResponse {
  success?: boolean;
  message?: string;
  status?: number;
  response?: unknown;
  error?: string;
}

export async function pushCardToSilly(cardId: string): Promise<PushCardResponse> {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  let data: PushCardResponse | null = null;
  try {
    data = (await res.json()) as PushCardResponse;
  } catch {
    // ignore JSON parse errors for non-JSON responses
  }

  if (!res.ok) {
    const errorMessage = data?.error || data?.message || `Failed to push card (status ${res.status})`;
    throw new Error(errorMessage);
  }

  return data || { success: true };
}

export async function pushCardToArchitect(cardId: string): Promise<PushCardResponse> {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/push-to-architect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  let data: PushCardResponse | null = null;
  try {
    data = (await res.json()) as PushCardResponse;
  } catch {
    // ignore JSON parse errors for non-JSON responses
  }

  if (!res.ok) {
    const errorMessage = data?.error || data?.message || `Failed to push card to Character Architect (status ${res.status})`;
    throw new Error(errorMessage);
  }

  return data || { success: true };
}

export async function bulkDeleteCards(cardIds: string[]) {
  const res = await fetch(`${API_BASE}/api/cards/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_ids: cardIds }),
  });
  if (!res.ok) throw new Error('Failed to bulk delete');
  return res.json();
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function updateConfig(config: Partial<Config>) {
  const res = await fetch(`${API_BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to update config');
  return res.json();
}

export async function searchTags(query: string, limit: number = 20): Promise<string[]> {
  const params = new URLSearchParams();
  if (query) params.append('q', query);
  params.append('limit', limit.toString());
  
  const res = await fetch(`${API_BASE}/api/tags/search?${params.toString()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to search tags');
  return res.json();
}

export async function fetchTagAliases(): Promise<TagAliasesResponse> {
  const res = await fetch(`${API_BASE}/api/tag-aliases`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load tag aliases');
  return res.json();
}

export async function rerollTags(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/tags/random`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to reroll tags');
  return res.json();
}

export async function startSync(signal?: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/sync`, { signal });
  if (!res.body) throw new Error('Failed to start sync - no response body');
  return res.body;
}

export async function startCtSync(signal?: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/sync/ct`, { signal });
  if (!res.body) throw new Error('Failed to start CT sync - no response body');
  return res.body;
}

export async function startWyvernSync(signal?: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/sync/wyvern`, { signal });
  if (!res.body) throw new Error('Failed to start Wyvern sync - no response body');
  return res.body;
}

export async function startRisuAiSync(signal?: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/sync/risuai`, { signal });
  if (!res.body) throw new Error('Failed to start RisuAI sync - no response body');
  return res.body;
}

export async function cancelAllSyncs() {
  const res = await fetch(`${API_BASE}/api/sync/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to cancel syncs');
  return res.json();
}

export async function getSyncStatus() {
  const res = await fetch(`${API_BASE}/api/sync/status`);
  if (!res.ok) throw new Error('Failed to get sync status');
  return res.json();
}

export async function scanCardAssets(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/assets/scan`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to scan card assets');
  return res.json();
}

export async function cacheCardAssets(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/assets/cache`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to cache card assets');
  return res.json();
}

export async function getCachedAssets(cardId: string): Promise<CachedAssetsResponse> {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/assets`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to get cached assets');
  return res.json();
}

export async function clearCachedAssets(cardId: string) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/assets`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to clear cached assets');
  return res.json();
}

export async function exportCard(cardId: string, useLocal: boolean = false) {
  const params = new URLSearchParams();
  if (useLocal) params.append('useLocal', 'true');

  const res = await fetch(`${API_BASE}/api/cards/${cardId}/export?${params.toString()}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to export card');

  // Return the blob for download
  const blob = await res.blob();
  const contentDisposition = res.headers.get('Content-Disposition');
  const filename = contentDisposition?.match(/filename="(.+)"/)?.[1] || `card-${cardId}.png`;

  return { blob, filename };
}

export async function fetchChubFollows(profile?: string): Promise<ChubFollowsResponse> {
  const params = new URLSearchParams();
  if (profile) {
    params.append('profile', profile);
  }
  const url = `${API_BASE}/api/chub/follows${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const message = errorBody?.error || 'Failed to fetch followed creators from Chub';
    throw new Error(message);
  }
  return res.json();
}

export async function fetchChubBlockedUsers(): Promise<ChubBlockedUsersResponse> {
  const res = await fetch(`${API_BASE}/api/sync/chub/blocked`, { cache: 'no-store' });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const message = errorBody?.error || 'Failed to fetch blocked users from Chub';
    throw new Error(message);
  }
  return res.json();
}

// ============================================================================
// Federation API
// ============================================================================

export async function fetchFederationPlatforms(): Promise<{ platforms: FederationPlatform[] }> {
  const res = await fetch(`${API_BASE}/api/federation/platforms`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch federation platforms');
  return res.json();
}

export async function updateFederationPlatform(
  platform: string,
  config: { base_url?: string; api_key?: string; enabled?: boolean }
): Promise<{ success: boolean; platform: FederationPlatform }> {
  const res = await fetch(`${API_BASE}/api/federation/platforms/${platform}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to update platform configuration');
  return res.json();
}

export async function testPlatformConnection(platform: string): Promise<ConnectionTestResult> {
  const res = await fetch(`${API_BASE}/api/federation/platforms/${platform}/test`, {
    method: 'POST',
  });
  return res.json();
}

export async function fetchCardSyncState(cardId: string): Promise<{ cardId: string; syncStates: SyncState[] }> {
  const res = await fetch(`${API_BASE}/api/federation/cards/${cardId}/sync`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch sync state');
  return res.json();
}

export async function pushCardToPlatform(
  cardId: string,
  platform: string,
  overwrite: boolean = false
): Promise<PushResult> {
  const res = await fetch(`${API_BASE}/api/federation/cards/${cardId}/push/${platform}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overwrite }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Push failed' }));
    throw new Error(error.error || 'Push failed');
  }
  return res.json();
}

export async function bulkPushToPlatform(
  cardIds: string[],
  platform: string,
  overwrite: boolean = false
): Promise<BulkPushResult> {
  const res = await fetch(`${API_BASE}/api/federation/bulk-push/${platform}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardIds, overwrite }),
  });
  if (!res.ok) throw new Error('Bulk push failed');
  return res.json();
}

export async function clearCardSync(cardId: string, platform?: string): Promise<{ success: boolean }> {
  const url = platform
    ? `${API_BASE}/api/federation/cards/${cardId}/sync/${platform}`
    : `${API_BASE}/api/federation/cards/${cardId}/sync`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to clear sync state');
  return res.json();
}

// ============================================================================
// Metrics API
// ============================================================================

export interface MetricsStats {
  totalCards: number;
  cardsBySource: Record<string, number>;
  avgTokenCount: number;
  medianTokenCount: number;
  totalTokens: number;
  minTokens: number;
  maxTokens: number;
  newCardsToday: number;
  newCardsThisWeek: number;
  favoritedCount: number;
  cardsWithLorebook: number;
  cardsWithGallery: number;
  cardsWithExpressions: number;
  cardsWithAlternateGreetings: number;
  cardsWithSystemPrompt: number;
  cardsWithExampleDialogues: number;
  topTags: { tag: string; count: number }[];
  largestCards: { id: number; name: string; author: string; tokenCount: number; source: string }[];
  tokenDistribution: { label: string; count: number }[];
  source: 'realtime' | 'snapshot';
  computedAt?: string;
}

export interface TimelineEntry {
  date: string;
  count: number;
}

export async function fetchMetricsStats(realtime = false): Promise<MetricsStats> {
  const url = `${API_BASE}/api/metrics/stats${realtime ? '?realtime=true' : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch metrics');
  return res.json();
}

export async function fetchMetricsTimeline(days = 30): Promise<TimelineEntry[]> {
  const res = await fetch(`${API_BASE}/api/metrics/timeline?days=${days}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch timeline');
  return res.json();
}

export async function fetchTopTags(limit = 50): Promise<{ tag: string; count: number }[]> {
  const res = await fetch(`${API_BASE}/api/metrics/top-tags?limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch top tags');
  return res.json();
}

export async function fetchTokenDistribution(): Promise<{ label: string; count: number }[]> {
  const res = await fetch(`${API_BASE}/api/metrics/distribution`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch distribution');
  return res.json();
}

export interface TrendingTag {
  tag: string;
  count: number;
  change: number;
  isNew: boolean;
  rankChange?: number;
}

export async function fetchTrendingTags(limit = 20): Promise<TrendingTag[]> {
  const res = await fetch(`${API_BASE}/api/metrics/trending-tags?limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch trending tags');
  return res.json();
}

export interface TopCardByPlatform {
  id: number;
  name: string;
  author: string;
  tokenCount: number;
  starCount: number | null;
  nChats: number | null;
  nMessages: number | null;
}

export async function fetchTopCardsByPlatform(limit = 5): Promise<Record<string, TopCardByPlatform[]>> {
  const res = await fetch(`${API_BASE}/api/metrics/top-cards-by-platform?limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch top cards by platform');
  return res.json();
}

