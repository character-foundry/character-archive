import { useState, useEffect, useCallback } from "react";
import { fetchConfig as fetchConfigApi, updateConfig as updateConfigApi } from "@/lib/api";
import type { Config } from "@/lib/types";
import { defaultSillyTavernState, defaultCtSyncState, defaultVectorSearchState, defaultWyvernSyncState } from "../types/config";

interface UseConfigResult {
  config: Config | null;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  loading: boolean;
  saveStatus: { type: "success" | "error"; message: string } | null;
  saveConfig: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Custom hook for managing application configuration
 * Handles config loading, saving, validation, and settings modal state
 */
export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<Config | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Load config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const configData = await fetchConfigApi();
        setConfig(configData);
      } catch (err) {
        console.error("Failed to load config", err);
      }
    };
    loadConfig();
  }, []);

  // Auto-dismiss success/error messages after 3.5 seconds
  useEffect(() => {
    if (!saveStatus) return;
    const timer = setTimeout(() => setSaveStatus(null), 3500);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  // Clear save status when settings modal closes
  useEffect(() => {
    if (!showSettings) {
      setSaveStatus(null);
    }
  }, [showSettings]);

  const refetch = useCallback(async () => {
    try {
      const configData = await fetchConfigApi();
      setConfig(configData);
    } catch (err) {
      console.error("Failed to refetch config", err);
    }
  }, []);

  const saveConfig = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaveStatus(null);
      const data = new FormData(event.currentTarget);

      const getStringValue = (name: string, options: { trim?: boolean } = {}) => {
        const raw = data.get(name);
        if (typeof raw !== "string") return "";
        return options.trim ? raw.trim() : raw;
      };

      const parseDelimitedList = (name: string) => {
        const raw = getStringValue(name);
        if (!raw) return [] as string[];
        return raw
          .split(/[\n,]/)
          .map(entry => entry.trim())
          .filter(Boolean);
      };

      const parseNumberValue = (name: string, fallback: number) => {
        const parsed = parseInt(getStringValue(name, { trim: true }), 10);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      const parseFloatValue = (name: string, fallback: number) => {
        const parsed = parseFloat(getStringValue(name, { trim: true }));
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      const previousConfig = config || ({} as Config);

      // Parse Silly Tavern extra headers JSON
      const sillyExtraHeadersRaw = getStringValue("silly_extraHeaders", { trim: true });
      let sillyExtraHeaders: Record<string, string> = {};
      if (sillyExtraHeadersRaw) {
        try {
          sillyExtraHeaders = JSON.parse(sillyExtraHeadersRaw);
        } catch (error) {
          console.error("Invalid Silly Tavern headers JSON", error);
          window.alert("Invalid JSON provided for Silly Tavern extra headers.");
          return;
        }
      }

      const previousSilly = previousConfig.sillyTavern || defaultSillyTavernState;
      const sillyImportEndpointRaw = getStringValue("silly_importEndpoint", { trim: true });
      const sillyConfig = {
        ...previousSilly,
        enabled: data.get("silly_enabled") === "on",
        baseUrl: getStringValue("silly_baseUrl", { trim: true }),
        importEndpoint: sillyImportEndpointRaw || previousSilly.importEndpoint || defaultSillyTavernState.importEndpoint,
        csrfToken: getStringValue("silly_csrfToken", { trim: true }),
        sessionCookie: getStringValue("silly_sessionCookie", { trim: true }),
        extraHeaders: sillyExtraHeaders,
      };

      const previousCtSync = previousConfig.ctSync || defaultCtSyncState;
      const ctConfig = {
        ...previousCtSync,
        enabled: data.get("ct_enabled") === "on",
        intervalMinutes: parseNumberValue("ct_intervalMinutes", previousCtSync.intervalMinutes),
        pages: parseNumberValue("ct_pages", previousCtSync.pages),
        hitsPerPage: parseNumberValue("ct_hitsPerPage", previousCtSync.hitsPerPage),
        minTokens: parseNumberValue("ct_minTokens", previousCtSync.minTokens),
        maxTokens: parseNumberValue("ct_maxTokens", previousCtSync.maxTokens),
        bannedTags: parseDelimitedList("ct_bannedTags"),
        excludedWarnings: parseDelimitedList("ct_excludedWarnings"),
        bearerToken: getStringValue("ct_bearerToken", { trim: true }),
        cfClearance: getStringValue("ct_cfClearance", { trim: true }),
        session: getStringValue("ct_session", { trim: true }),
        allowedWarnings: getStringValue("ct_allowedWarnings", { trim: true }),
      };

      const risuAiConfig = {
        enabled: data.get("risu_enabled") === "on",
        pageLimit: parseNumberValue("risu_pageLimit", previousConfig.risuAiSync?.pageLimit ?? 5),
        forceUpdate: data.get("risu_forceUpdate") === "on",
      };

      const previousWyvern = previousConfig.wyvernSync || defaultWyvernSyncState;
      const wyvernConfig = {
        enabled: data.get("wyvern_enabled") === "on",
        pageLimit: parseNumberValue("wyvern_pageLimit", previousWyvern.pageLimit),
        itemsPerPage: parseNumberValue("wyvern_itemsPerPage", previousWyvern.itemsPerPage),
        rating: getStringValue("wyvern_rating", { trim: true }) || previousWyvern.rating,
        bearerToken: getStringValue("wyvern_bearerToken", { trim: true }),
      };

      const previousVector = previousConfig.vectorSearch || defaultVectorSearchState;
      const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
      const vectorConfig: NonNullable<Config["vectorSearch"]> = {
        ...previousVector,
        enabled: data.get("vector_enabled") === "on",
        enableChunks: data.get("vector_enableChunks") === "on",
        cardsIndex: getStringValue("vector_cardsIndex", { trim: true }) || previousVector.cardsIndex,
        chunksIndex: getStringValue("vector_chunksIndex", { trim: true }) || previousVector.chunksIndex,
        embedModel: getStringValue("vector_embedModel", { trim: true }) || previousVector.embedModel,
        embedderName: getStringValue("vector_embedderName", { trim: true }) || previousVector.embedderName,
        embedDimensions: Math.max(
          1,
          parseNumberValue(
            "vector_embedDimensions",
            previousVector.embedDimensions ?? defaultVectorSearchState.embedDimensions,
          ),
        ),
        embeddingProvider: data.get("vector_embeddingProvider") === "openai" ? "openai" : "ollama",
        embeddingUrl: getStringValue("vector_embeddingUrl", { trim: true }),
        embeddingApiKey: getStringValue("vector_embeddingApiKey", { trim: true }),
        ollamaUrl: getStringValue("vector_ollamaUrl", { trim: true }) || previousVector.ollamaUrl,
        semanticRatio: clamp(
          parseFloatValue("vector_semanticRatio", previousVector.semanticRatio ?? defaultVectorSearchState.semanticRatio),
          0,
          1,
        ),
        cardsMultiplier: Math.max(
          1,
          parseFloatValue("vector_cardsMultiplier", previousVector.cardsMultiplier ?? defaultVectorSearchState.cardsMultiplier),
        ),
        maxCardHits: Math.max(
          50,
          parseNumberValue("vector_maxCardHits", previousVector.maxCardHits ?? defaultVectorSearchState.maxCardHits),
        ),
        chunkLimit: Math.max(
          20,
          parseNumberValue("vector_chunkLimit", previousVector.chunkLimit ?? defaultVectorSearchState.chunkLimit),
        ),
        chunkWeight: Math.max(
          0,
          parseFloatValue("vector_chunkWeight", previousVector.chunkWeight ?? defaultVectorSearchState.chunkWeight),
        ),
        rrfK: Math.max(1, parseNumberValue("vector_rrfK", previousVector.rrfK ?? defaultVectorSearchState.rrfK)),
      };

      const updatedConfig: Config = {
        ...previousConfig,
        apikey: getStringValue("apikey"),
        chubApiKey: getStringValue("chubApiKey"),
        autoUpdateMode: data.get("autoUpdateMode") === "on",
        autoUpdateInterval: parseNumberValue("autoUpdateInterval", previousConfig.autoUpdateInterval ?? 900),
        min_tokens: parseNumberValue("min_tokens", previousConfig.min_tokens ?? 0),
        chubProfileName: getStringValue("chubProfileName", { trim: true }),
        syncLimit: parseNumberValue("syncLimit", previousConfig.syncLimit ?? 20),
        pageLimit: parseNumberValue("pageLimit", previousConfig.pageLimit ?? 10),
        startPage: parseNumberValue("startPage", previousConfig.startPage ?? 1),
        cycle_topics: data.get("cycle_topics") === "on",
        topic: getStringValue("topic"),
        excludeTopic: getStringValue("excludeTopic"),
        followedCreators: parseDelimitedList("followedCreators"),
        followedCreatorsOnly: data.get("followedCreatorsOnly") === "on",
        blockedCreators: parseDelimitedList("blockedCreators"),
        syncFollowedCreators: data.get("syncFollowedCreators") === "on",
        syncTagsMode: data.get("syncTagsMode") === "on",
        backupMode: data.get("backupMode") === "on",
        use_timeline: data.get("use_timeline") === "on",
        publicBaseUrl: getStringValue("publicBaseUrl", { trim: true }),
        sillyTavern: sillyConfig,
        ctSync: ctConfig,
        risuAiSync: risuAiConfig,
        wyvernSync: wyvernConfig,
        vectorSearch: vectorConfig,
      };

      setLoading(true);
      try {
        await updateConfigApi(updatedConfig);
        const refreshedConfig = await fetchConfigApi();
        setConfig(refreshedConfig);
        setSaveStatus({ type: "success", message: "Settings saved." });
      } catch (err: unknown) {
        console.error("Failed to save config", err);
        setSaveStatus({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to save settings.",
        });
      } finally {
        setLoading(false);
      }
    },
    [config],
  );

  return {
    config,
    setConfig,
    showSettings,
    setShowSettings,
    loading,
    saveStatus,
    saveConfig,
    refetch,
  };
}
