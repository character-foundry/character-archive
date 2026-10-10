import fs from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';
import { instanceApiUrl, connectionHeaders } from '@character-foundry/character-foundry/integrations';
import { appConfig } from './ConfigState.js';
import { getCardFilePaths } from '../utils/card-utils.js';
import { exportCtWyvernPng } from './CtWyvernPngExportService.js';
import { linkArchitectCard, reconcileFavorites } from './FavoriteSyncService.js';

export async function pushDirect(cardId, target) {
    const connection = target === 'architect'
        ? { baseUrl: appConfig.characterArchitect?.url, enabled: appConfig.characterArchitect?.enabled !== false }
        : appConfig.lumiverse;
    if (!connection?.enabled || !connection.baseUrl) throw new Error(`Configure ${target === 'architect' ? 'Character Architect' : 'Lumiverse'} in Settings first`);
    const { pngPath } = getCardFilePaths(String(cardId));
    if (!fs.existsSync(pngPath)) throw new Error('Card PNG file not found');
    const png = await exportCtWyvernPng(cardId) || fs.readFileSync(pngPath);
    const form = new FormData();
    form.append('file', png, { filename: `${cardId}.png`, contentType: 'image/png' });
    const url = instanceApiUrl(connection.baseUrl, target === 'architect' ? 'import' : 'characters/import');
    const response = await axios.post(url, form, {
        headers: { ...connectionHeaders(connection), ...form.getHeaders() },
        timeout: 60000, maxRedirects: 0, maxBodyLength: Infinity
    });
    const remoteId = target === 'architect' ? response.data?.card?.meta?.id : response.data?.character?.id;
    if (typeof remoteId !== 'string' || !remoteId) throw new Error('The instance did not return an imported card. Check the URL and authentication.');
    if (target === 'architect') {
        await linkArchitectCard(cardId, connection.baseUrl, remoteId);
        void reconcileFavorites().catch(() => {});
    }
    return { success: true, method: 'direct', remoteId, message: `Card sent to ${target === 'architect' ? 'Character Architect' : 'Lumiverse'}` };
}

export async function testDirectConnection(target, settings) {
    const baseUrl = target === 'architect' ? settings.url : settings.baseUrl;
    const { data } = await axios.get(instanceApiUrl(baseUrl, target === 'architect' ? 'cards?limit=1' : 'characters?limit=1'), {
        headers: connectionHeaders({ ...settings, baseUrl }), timeout: 10000, maxRedirects: 0
    });
    if (!Array.isArray(target === 'architect' ? data?.items : data?.data)) throw new Error('The URL did not return an API response');
    return { success: true };
}
