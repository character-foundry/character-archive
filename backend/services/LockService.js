
class LockService {
    constructor() {
        this.syncInProgress = false;
        this.ctSyncInProgress = false;
        this.syncAborted = false;
        this.ctSyncAborted = false;
    }

    isSyncInProgress() {
        return this.syncInProgress;
    }

    setSyncInProgress(value) {
        this.syncInProgress = !!value;
        if (value) {
            this.syncAborted = false; // Reset abort flag when starting new sync
        }
    }

    isCtSyncInProgress() {
        return this.ctSyncInProgress;
    }

    setCtSyncInProgress(value) {
        this.ctSyncInProgress = !!value;
        if (value) {
            this.ctSyncAborted = false; // Reset abort flag when starting new sync
        }
    }

    // Abort flags
    isSyncAborted() {
        return this.syncAborted;
    }

    abortSync() {
        this.syncAborted = true;
    }

    isCtSyncAborted() {
        return this.ctSyncAborted;
    }

    abortCtSync() {
        this.ctSyncAborted = true;
    }

    // Cancel all syncs
    abortAllSyncs() {
        this.syncAborted = true;
        this.ctSyncAborted = true;
    }

    // Get status of all syncs
    getSyncStatus() {
        return {
            chub: { inProgress: this.syncInProgress, aborted: this.syncAborted },
            ct: { inProgress: this.ctSyncInProgress, aborted: this.ctSyncAborted },
            // Wyvern and RisuAI share the main sync lock
            wyvern: { inProgress: this.syncInProgress, aborted: this.syncAborted },
            risuai: { inProgress: this.syncInProgress, aborted: this.syncAborted },
        };
    }
}

export const lockService = new LockService();
