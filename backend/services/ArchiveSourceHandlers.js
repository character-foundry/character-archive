import { syncChub } from './scrapers/ChubScraper.js';
import { syncCharacterTavern } from './scrapers/CtScraper.js';
import { syncRisuAi } from './scrapers/RisuAiScraper.js';
import { syncWyvern } from './scrapers/WyvernScraper.js';
import { lockService } from './LockService.js';

function sourceIsEnabled(source, config) {
    if (source === 'chub') return true;
    if (source === 'ct') return config.ctSync?.enabled === true;
    if (source === 'risuai') return config.risuAiSync?.enabled === true;
    if (source === 'wyvern') return config.wyvernSync?.enabled === true;
    return false;
}

function adapt(source, handler) {
    return async ({ config, progress, isCancelled }) => {
        if (!sourceIsEnabled(source, config)) return { skipped: true };
        const isCt = source === 'ct';
        const setInProgress = value => isCt
            ? lockService.setCtSyncInProgress(value)
            : lockService.setSyncInProgress(value);
        setInProgress(true);
        try {
            return await handler(config, payload => {
                progress(payload);
                if (isCancelled()) lockService.abortAllSyncs();
            });
        } finally {
            setInProgress(false);
        }
    };
}

export function createArchiveSourceHandlers() {
    return {
        chub: adapt('chub', syncChub),
        ct: adapt('ct', syncCharacterTavern),
        risuai: adapt('risuai', syncRisuAi),
        wyvern: adapt('wyvern', syncWyvern)
    };
}

export function getEnabledArchiveSources(config = {}) {
    const sources = ['chub'];
    if (config.ctSync?.enabled) sources.push('ct');
    if (config.risuAiSync?.enabled) sources.push('risuai');
    if (config.wyvernSync?.enabled) sources.push('wyvern');
    return sources;
}
