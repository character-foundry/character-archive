import test from 'node:test';
import assert from 'node:assert/strict';

import { createArchiveSourceHandlers } from './ArchiveSourceHandlers.js';
import { lockService } from './LockService.js';

test('disabled optional sources are recorded as skipped without calling their scraper', async () => {
    const result = await createArchiveSourceHandlers().ct({
        config: { ctSync: { enabled: false } },
        progress: () => {},
        isCancelled: () => false
    });
    assert.deepEqual(result, { skipped: true });
});

test('cancel-all raises abort flags even for worker-owned syncs', () => {
    lockService.setSyncInProgress(false);
    lockService.setCtSyncInProgress(false);
    lockService.abortAllSyncs();
    assert.equal(lockService.isSyncAborted(), true);
    assert.equal(lockService.isCtSyncAborted(), true);
    lockService.setSyncInProgress(true);
    lockService.setCtSyncInProgress(true);
    lockService.setSyncInProgress(false);
    lockService.setCtSyncInProgress(false);
});
