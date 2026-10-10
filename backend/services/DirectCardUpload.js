import fs from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';
import { instanceApiUrl, connectionHeaders } from '@character-foundry/character-foundry/integrations';
import { getCardFilePaths } from '../utils/card-utils.js';
import { lumiverseApiUrl } from '../utils/lumiverse.js';
import { exportCtWyvernPng } from './CtWyvernPngExportService.js';

export async function uploadCardPng(cardId, target, connection) {
    const { pngPath } = getCardFilePaths(String(cardId));
    if (!fs.existsSync(pngPath)) throw new Error('Card PNG file not found');
    const png = await exportCtWyvernPng(cardId) || fs.readFileSync(pngPath);
    const form = new FormData();
    form.append('file', png, { filename: `${cardId}.png`, contentType: 'image/png' });
    const url = target === 'architect'
        ? instanceApiUrl(connection.baseUrl, 'import')
        : lumiverseApiUrl(connection.baseUrl, 'characters/import');
    const response = await axios.post(url, form, {
        headers: { ...connectionHeaders(connection), ...form.getHeaders() },
        timeout: 60000, maxRedirects: 0, maxBodyLength: Infinity
    });
    const remoteId = target === 'architect' ? response.data?.card?.meta?.id : response.data?.character?.id;
    if (typeof remoteId !== 'string' || !remoteId) throw new Error('The instance did not return an imported card. Check the URL and authentication.');
    return remoteId;
}
