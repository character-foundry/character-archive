// Cache immutable search results, coalesce concurrent requests, and never retain failures.
export class AsyncResultCache {
    constructor({ ttlMs = 60000, maxEntries = 64, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.now = now;
        this.entries = new Map();
    }

    async get(key, compute) {
        let entry = this.entries.get(key);
        if (!entry || entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            while (this.entries.size >= this.maxEntries) {
                this.entries.delete(this.entries.keys().next().value);
            }
            entry = { expiresAt: Infinity };
            entry.promise = Promise.resolve().then(compute).then(value => {
                entry.expiresAt = this.now() + this.ttlMs;
                return value;
            }).catch(error => {
                if (this.entries.get(key) === entry) this.entries.delete(key);
                throw error;
            });
            this.entries.set(key, entry);
        }
        return structuredClone(await entry.promise);
    }

    clear() {
        this.entries.clear();
    }
}
