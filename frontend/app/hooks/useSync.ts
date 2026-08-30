import { useState, useRef, useEffect, useCallback } from "react";
import {
  startSync as startSyncApi,
  startCtSync as startCtSyncApi,
  startWyvernSync as startWyvernSyncApi,
  startRisuAiSync as startRisuAiSyncApi,
  cancelAllSyncs as cancelAllSyncsApi,
  getSyncStatus as getSyncStatusApi
} from "@/lib/api";
import type { SyncRun } from "@/lib/types";

interface SyncSourceState {
  syncing: boolean;
  status: string | null;
  start: () => Promise<void>;
  cancel: () => void;
}

interface UseSyncResult {
  // Chub sync
  syncing: boolean;
  syncStatus: string | null;
  startChubSync: () => Promise<void>;
  cancelChubSync: () => void;
  // CT sync
  ctSyncing: boolean;
  ctSyncStatus: string | null;
  startCtSync: () => Promise<void>;
  cancelCtSync: () => void;
  // Wyvern sync
  wyvernSyncing: boolean;
  wyvernSyncStatus: string | null;
  startWyvernSync: () => Promise<void>;
  cancelWyvernSync: () => void;
  // RisuAI sync
  risuSyncing: boolean;
  risuSyncStatus: string | null;
  startRisuSync: () => Promise<void>;
  cancelRisuSync: () => void;
  // Global
  anySyncing: boolean;
  latestSyncRun: SyncRun | null;
  cancelAllSyncs: () => void;
}

type SyncApiFunction = (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>;

/**
 * Generic hook for managing a single sync source
 */
function useSyncSource(
  sourceName: string,
  apiFunc: SyncApiFunction,
  onComplete?: () => void
): SyncSourceState {
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const processSSEStream = useCallback(async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (chunk.startsWith("data:")) {
          const payload = JSON.parse(chunk.replace("data: ", ""));
          if (payload.error) {
            setStatus(`Error: ${payload.error}`);
          } else if (payload.progress === 100) {
            setStatus(`${sourceName} sync complete. New cards: ${payload.newCards ?? payload.added ?? 0}`);
            if (onComplete) {
              onComplete();
            }
          } else {
            const progress = payload.progress ?? 0;
            const current = payload.currentCard ?? payload.name ?? '';
            const newCards = payload.newCards ?? payload.added ?? 0;
            setStatus(`${sourceName}: ${progress}% • ${current} (${newCards} new)`);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    reader.releaseLock();
  }, [sourceName, onComplete]);

  const start = useCallback(async () => {
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus(null);
    setSyncing(true);
    try {
      const stream = await apiFunc(controller.signal);
      if (stream) {
        await processSSEStream(stream);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError') {
        setStatus(`${sourceName} sync cancelled`);
      } else {
        console.error(error);
        setStatus(error.message || `Unable to sync from ${sourceName}`);
      }
    } finally {
      setSyncing(false);
      abortRef.current = null;
    }
  }, [cancel, apiFunc, processSSEStream, sourceName]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { syncing, status, start, cancel };
}

/**
 * Custom hook for managing sync operations for all sources
 * Handles SSE streams, AbortControllers, and sync progress status
 */
export function useSync(onSyncComplete?: () => void): UseSyncResult {
  // Create sync sources using the generic hook
  const chub = useSyncSource("Chub", startSyncApi, onSyncComplete);
  const ct = useSyncSource("CT", startCtSyncApi, onSyncComplete);
  const wyvern = useSyncSource("Wyvern", startWyvernSyncApi, onSyncComplete);
  const risu = useSyncSource("RisuAI", startRisuAiSyncApi, onSyncComplete);

  // Cancel all syncs at once - calls backend to stop + aborts frontend streams
  const cancelAllSyncs = async () => {
    try {
      await cancelAllSyncsApi();
    } catch (err) {
      console.error('Failed to cancel syncs on backend:', err);
    }
    chub.cancel();
    ct.cancel();
    wyvern.cancel();
    risu.cancel();
  };

  // Computed: is any sync currently running (locally initiated)?
  const anySyncingLocal = chub.syncing || ct.syncing || wyvern.syncing || risu.syncing;

  // Track backend sync status (for syncs started elsewhere or before page load)
  const [backendSyncStatus, setBackendSyncStatus] = useState<{
    chub: { inProgress: boolean };
    ct: { inProgress: boolean };
    wyvern: { inProgress: boolean };
    risuai: { inProgress: boolean };
    latestRun?: SyncRun | null;
    activeRuns?: SyncRun[];
  } | null>(null);

  // Poll backend status only when a sync is active
  useEffect(() => {
    // Skip polling if no sync is running
    if (!anySyncingLocal && !backendSyncStatus?.chub?.inProgress &&
        !backendSyncStatus?.ct?.inProgress && !backendSyncStatus?.wyvern?.inProgress &&
        !backendSyncStatus?.risuai?.inProgress) {
      // Do one initial check when component mounts
      const checkOnce = async () => {
        try {
          const status = await getSyncStatusApi();
          setBackendSyncStatus(status);
        } catch {
          // Ignore errors
        }
      };
      checkOnce();
      return;
    }

    const checkStatus = async () => {
      try {
        const status = await getSyncStatusApi();
        setBackendSyncStatus(status);
      } catch {
        // Ignore errors
      }
    };

    // Check immediately
    checkStatus();

    // Poll every 2 seconds only while sync is active
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, [anySyncingLocal, backendSyncStatus?.chub?.inProgress, backendSyncStatus?.ct?.inProgress,
      backendSyncStatus?.wyvern?.inProgress, backendSyncStatus?.risuai?.inProgress]);

  // Any sync running (local or backend)
  const anySyncing = Boolean(
    anySyncingLocal ||
      backendSyncStatus?.chub?.inProgress ||
      backendSyncStatus?.ct?.inProgress ||
      backendSyncStatus?.wyvern?.inProgress ||
      backendSyncStatus?.risuai?.inProgress
  );

  return {
    // Chub
    syncing: chub.syncing,
    syncStatus: chub.status,
    startChubSync: chub.start,
    cancelChubSync: chub.cancel,
    // CT
    ctSyncing: ct.syncing,
    ctSyncStatus: ct.status,
    startCtSync: ct.start,
    cancelCtSync: ct.cancel,
    // Wyvern
    wyvernSyncing: wyvern.syncing,
    wyvernSyncStatus: wyvern.status,
    startWyvernSync: wyvern.start,
    cancelWyvernSync: wyvern.cancel,
    // RisuAI
    risuSyncing: risu.syncing,
    risuSyncStatus: risu.status,
    startRisuSync: risu.start,
    cancelRisuSync: risu.cancel,
    // Global
    anySyncing,
    latestSyncRun: backendSyncStatus?.latestRun || null,
    cancelAllSyncs,
  };
}
