import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BLACKLIST_FILE = path.join(__dirname, '../../blacklist.txt');
const MIN_REQUEST_INTERVAL = 1000;
let lastRequestTime = 0;
const blacklistSet = new Set();

function isTransientRequestError(error) {
    const status = Number(error?.response?.status);
    if ([408, 425, 429].includes(status) || status >= 500) return true;
    return ['ECONNABORTED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'].includes(error?.code);
}

export async function retryTransientRequest(request, options = {}) {
    const delays = options.delays || [1000, 3000];
    const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await request();
        } catch (error) {
            if (!isTransientRequestError(error) || attempt >= delays.length) throw error;
            const delay = delays[attempt];
            options.onRetry?.({ attempt: attempt + 1, delay, error });
            await sleep(delay);
        }
    }
}

export function loadBlacklist() {
    if (fs.existsSync(BLACKLIST_FILE)) {
        const content = fs.readFileSync(BLACKLIST_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const id = line.trim();
            if (id) blacklistSet.add(id);
        });
    }
}

export function addToBlacklist(cardId) {
    blacklistSet.add(String(cardId));
    fs.appendFileSync(BLACKLIST_FILE, `${cardId}\n`);
}

export function isBlacklisted(cardId) {
    return blacklistSet.has(String(cardId));
}

export async function rateLimitedRequest(url, options = {}) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    
    if (elapsed < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    
    lastRequestTime = Date.now();
    return axios.get(url, options);
}

export function createChubClient(apiKey = '') {
    return axios.create({
        headers: {
            'samwise': apiKey,
            'CH-API-KEY': apiKey,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Origin': 'https://chub.ai',
            'Connection': 'keep-alive',
            'Referer': 'https://chub.ai/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        },
        timeout: 30000
    });
}
