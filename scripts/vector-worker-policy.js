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

export function drainDecision({ enabled = false, worked = false, generation = null, deadlineReached = false } = {}) {
    if (!enabled) return 'continue';
    if (deadlineReached) return 'timeout';
    if (worked) return 'continue';
    if (!generation) return 'complete';
    if (generation.status === 'failed' || Number(generation.dead_items || 0) > 0) return 'failed';
    const pending = Number(generation.queued_items || 0)
        + Number(generation.retry_items || 0)
        + Number(generation.running_items || 0);
    return pending === 0 ? 'complete' : 'wait';
}

// Service outages must not exhaust the retry budget of otherwise valid cards.
export function isTransientVectorFailure(error) {
    return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|TimeoutError|AbortError|timed out|embedding request failed: (?:408|429|5\d\d)\b/i.test(error?.message || String(error));
}
