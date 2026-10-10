import axios from 'axios';
import { instanceApiUrl, connectionHeaders } from '@character-foundry/character-foundry/integrations';
import { appConfig } from './ConfigState.js';
import { lumiverseApiUrl } from '../utils/lumiverse.js';
import { uploadCardPng } from './DirectCardUpload.js';
import { ensureArchitectCard, reconcileFavorites } from './FavoriteSyncService.js';

export async function pushDirect(cardId, target) {
    const connection = target === 'architect'
        ? { baseUrl: appConfig.characterArchitect?.url, enabled: appConfig.characterArchitect?.enabled !== false }
        : appConfig.lumiverse;
    if (!connection?.enabled || !connection.baseUrl) throw new Error(`Configure ${target === 'architect' ? 'Character Architect' : 'Lumiverse'} in Settings first`);
    const remoteId = target === 'architect'
        ? await ensureArchitectCard(cardId, connection.baseUrl)
        : await uploadCardPng(cardId, target, connection);
    if (target === 'architect') {
        void reconcileFavorites().catch(() => {});
    }
    return { success: true, method: 'direct', remoteId, message: `Card sent to ${target === 'architect' ? 'Character Architect' : 'Lumiverse'}` };
}

export async function testDirectConnection(target, settings) {
    const baseUrl = target === 'architect' ? settings.url : settings.baseUrl;
    const url = target === 'architect' ? instanceApiUrl(baseUrl, 'cards?limit=1') : lumiverseApiUrl(baseUrl, 'characters?limit=1');
    const { data } = await axios.get(url, {
        headers: connectionHeaders({ ...settings, baseUrl }), timeout: 10000, maxRedirects: 0
    });
    if (!Array.isArray(target === 'architect' ? data?.items : data?.data)) throw new Error('The URL did not return an API response');
    return { success: true };
}
