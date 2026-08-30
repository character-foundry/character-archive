function explicitBoolean(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
}

export function shouldPauseForArchiveSync({ provider, setting } = {}) {
    const override = explicitBoolean(setting);
    if (override !== null) return override;
    return String(provider || '').trim().toLowerCase() === 'meilisearch';
}
