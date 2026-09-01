import { useState, useCallback, useMemo, useEffect } from "react";
import {
  fetchCardMetadata,
  fetchCardGallery,
  getCachedAssets,
} from "@/lib/api";
import type { Card, GalleryAsset, CachedAsset } from "@/lib/types";

interface CardDetails {
  metadata: Record<string, any> | null;
  pngInfo: Record<string, any> | null;
  gallery: GalleryAsset[];
  galleryError: string | null;
}

interface UseCardDetailsResult {
  selectedCard: Card | null;
  cardDetails: CardDetails;
  detailsLoading: boolean;
  galleryLoading: boolean;
  galleryMessage: { type: "success" | "error"; message: string } | null;
  setGalleryMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
  setGalleryLoading: (loading: boolean) => void;
  cachedAssetsDetails: CachedAsset[];
  cachedAssetsLoading: boolean;
  assetCacheStatus: { cached: boolean; count: number } | null;
  setAssetCacheStatus: (status: { cached: boolean; count: number } | null) => void;
  assetCacheMessage: { type: "success" | "error"; message: string } | null;
  setAssetCacheMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
  openCardDetails: (card: Card, updateURL?: (cardId: string) => void) => Promise<void>;
  closeCardDetails: (updateURL?: () => void) => void;
  setSelectedCard: React.Dispatch<React.SetStateAction<Card | null>>;
  setCardDetails: React.Dispatch<React.SetStateAction<CardDetails>>;
  refreshCachedAssets: () => Promise<void>;
  // Computed values from card details
  pngData: Record<string, any> | null;
  definitionData: Record<string, any> | null;
  resolveTextField: (key: string) => string;
  tokenCounts: Record<string, number> | null;
  textSections: Array<{ title: string; value: string; defaultOpen?: boolean }>;
  alternateGreetings: string[];
  lorebookEntries: any[];
  linkedLorebooks: any[];
  galleryAssets: GalleryAsset[];
  shouldShowGallerySection: boolean;
  activeAuthor: string;
  activeAuthorDisplay: string;
  activeAuthorClickable: boolean;
}

export function useCardDetails(
  cards: Card[],
  setCards: React.Dispatch<React.SetStateAction<Card[]>>
): UseCardDetailsResult {
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [cardDetails, setCardDetails] = useState<CardDetails>({
    metadata: null,
    pngInfo: null,
    gallery: [],
    galleryError: null,
  });
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryMessage, setGalleryMessage] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [cachedAssetsDetails, setCachedAssetsDetails] = useState<CachedAsset[]>([]);
  const [cachedAssetsLoading, setCachedAssetsLoading] = useState(false);
  const [assetCacheStatus, setAssetCacheStatus] = useState<{ cached: boolean; count: number } | null>(null);
  const [assetCacheMessage, setAssetCacheMessage] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Clear gallery message when card closes
  useEffect(() => {
    if (!selectedCard) {
      setGalleryMessage(null);
    }
  }, [selectedCard]);

  // Load asset cache status when card is selected
  useEffect(() => {
    if (!selectedCard) {
      setAssetCacheStatus(null);
      setAssetCacheMessage(null);
      setCachedAssetsDetails([]);
      return;
    }

    const loadCacheStatus = async () => {
      setCachedAssetsLoading(true);
      try {
        const assets = await getCachedAssets(selectedCard.id);
        setAssetCacheStatus({
          cached: assets.assets && assets.assets.length > 0,
          count: assets.assets?.length || 0,
        });
        setCachedAssetsDetails(assets.assets || []);
      } catch (err) {
        console.error("Failed to load cache status:", err);
        setAssetCacheStatus({ cached: false, count: 0 });
        setCachedAssetsDetails([]);
      } finally {
        setCachedAssetsLoading(false);
      }
    };

    loadCacheStatus();
  }, [selectedCard]);

  const refreshCachedAssets = useCallback(async () => {
    if (!selectedCard) return;
    try {
      const assets = await getCachedAssets(selectedCard.id);
      setAssetCacheStatus({
        cached: assets.assets && assets.assets.length > 0,
        count: assets.assets?.length || 0,
      });
      setCachedAssetsDetails(assets.assets || []);
    } catch (err) {
      console.error("Failed to refresh cache status:", err);
    }
  }, [selectedCard]);

  const openCardDetails = useCallback(async (card: Card, updateURL?: (cardId: string) => void) => {
    setSelectedCard(card);
    updateURL?.(card.id.toString());
    setDetailsLoading(true);
    const shouldFetchGallery = card.favorited === 1 || card.hasGallery;
    setGalleryLoading(shouldFetchGallery);
    setGalleryMessage(null);

    try {
      const [metadata, galleryResult] = await Promise.all([
        fetchCardMetadata(card.id).catch(() => null),
        shouldFetchGallery
          ? fetchCardGallery(card.id).catch(err => ({
              success: false,
              assets: [],
              error: err?.message || "Failed to load gallery"
            }))
          : Promise.resolve(null),
      ]);

      const metadataFlags = metadata
        ? {
            hasAlternateGreetings: typeof metadata.hasAlternateGreetings === "boolean"
              ? metadata.hasAlternateGreetings
              : card.hasAlternateGreetings,
            hasLorebook: typeof metadata.hasLorebook === "boolean"
              ? metadata.hasLorebook
              : card.hasLorebook,
            hasEmbeddedLorebook: typeof metadata.hasEmbeddedLorebook === "boolean"
              ? metadata.hasEmbeddedLorebook
              : card.hasEmbeddedLorebook,
            hasLinkedLorebook: typeof metadata.hasLinkedLorebook === "boolean"
              ? metadata.hasLinkedLorebook
              : card.hasLinkedLorebook,
            hasExampleDialogues: typeof metadata.hasExampleDialogues === "boolean"
              ? metadata.hasExampleDialogues
              : card.hasExampleDialogues,
            hasSystemPrompt: typeof metadata.hasSystemPrompt === "boolean"
              ? metadata.hasSystemPrompt
              : card.hasSystemPrompt,
            hasGallery: typeof metadata.hasGallery === "boolean"
              ? metadata.hasGallery
              : card.hasGallery,
          }
        : null;

      const metadataFlagsChanged = metadataFlags && Object.entries(metadataFlags).some(
        ([key, value]) => Boolean((card as any)[key]) !== value
      );
      if (metadataFlagsChanged) {
        setSelectedCard(prev => (prev && prev.id === card.id ? { ...prev, ...metadataFlags } : prev));
        setCards(prev =>
          prev.map(existing => (existing.id === card.id ? { ...existing, ...metadataFlags } : existing))
        );
      }

      const galleryAssets = galleryResult && galleryResult.success !== false
        ? galleryResult.assets ?? []
        : [];
      const galleryError = galleryResult && galleryResult.success === false
        ? galleryResult.error || "Unable to load gallery"
        : null;

      setCardDetails({
        metadata: metadata && metadataFlags ? { ...metadata, ...metadataFlags } : metadata,
        pngInfo: null,
        gallery: galleryAssets,
        galleryError,
      });
    } catch (err) {
      console.error(err);
      setCardDetails({ metadata: null, pngInfo: null, gallery: [], galleryError: null });
    } finally {
      setDetailsLoading(false);
      setGalleryLoading(false);
    }
  }, [setCards]);

  const closeCardDetails = useCallback((updateURL?: () => void) => {
    setSelectedCard(null);
    setGalleryLoading(false);
    setGalleryMessage(null);
    updateURL?.();
  }, []);

  // Computed values
  const pngData = cardDetails.pngInfo?.data?.data ?? null;

  const definitionData = useMemo(() => {
    const metadata = cardDetails.metadata as any;
    if (metadata?.definition?.data) return metadata.definition.data as Record<string, any>;
    if (metadata?.data && typeof metadata.data === "object") return metadata.data as Record<string, any>;
    if (metadata?.definition && typeof metadata.definition === "object") {
      return metadata.definition as Record<string, any>;
    }
    return null;
  }, [cardDetails.metadata]);

  const resolveTextField = useCallback((key: string) => {
    const pickValue = (source: Record<string, any> | null | undefined) => {
      if (!source) return "";
      const value = source[key];
      if (typeof value === "string") {
        return value.trim().length > 0 ? value : "";
      }
      return "";
    };

    const fromPng = pickValue(pngData);
    if (fromPng) return fromPng;
    return pickValue(definitionData);
  }, [pngData, definitionData]);

  const tokenCounts = useMemo(() => {
    const labels = (cardDetails.metadata as any)?.labels;
    if (cardDetails.metadata && cardDetails.metadata.tokenCounts) {
      return cardDetails.metadata.tokenCounts as Record<string, number>;
    }
    if (!Array.isArray(labels)) return null;
    const tokenLabel = labels.find((label: any) => label.title === "TOKEN_COUNTS");
    if (!tokenLabel?.description) return null;
    try {
      return JSON.parse(tokenLabel.description);
    } catch {
      return null;
    }
  }, [cardDetails.metadata]);

  const textSections = useMemo(() => {
    const sections: Array<{ title: string; value: string; defaultOpen?: boolean }> = [
      { title: "Description", value: resolveTextField("description") },
      { title: "Scenario", value: resolveTextField("scenario") },
      { title: "Personality", value: resolveTextField("personality") },
      { title: "First Message", value: resolveTextField("first_mes"), defaultOpen: true },
      { title: "Message Examples", value: resolveTextField("mes_example") },
      { title: "System Prompt", value: resolveTextField("system_prompt") },
      { title: "Post-History Instructions", value: resolveTextField("post_history_instructions") },
    ];

    return sections.filter(section => section.value && section.value.trim().length > 0);
  }, [resolveTextField]);

  const alternateGreetings = useMemo(() => {
    const pick = (source: Record<string, any> | null | undefined) =>
      source?.alternate_greetings && Array.isArray(source.alternate_greetings)
        ? source.alternate_greetings.filter((g: any) => typeof g === "string" && g.trim().length > 0)
        : [];

    const fromPng = pick(pngData);
    if (fromPng.length > 0) return fromPng;
    return pick(definitionData);
  }, [pngData, definitionData]);

  const lorebookEntries = useMemo(() => {
    const entries =
      (pngData as any)?.character_book?.entries ??
      (definitionData as any)?.character_book?.entries ??
      [];
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && typeof entry === "object");
  }, [pngData, definitionData]);

  const linkedLorebooks = useMemo(() => {
    const related = cardDetails.metadata?.related_lorebooks;
    if (!Array.isArray(related)) return [];
    return related.filter(lorebook => lorebook && typeof lorebook === "object");
  }, [cardDetails.metadata]);

  const galleryAssets = cardDetails.gallery ?? [];

  const shouldShowGallerySection = useMemo(() => {
    if (!selectedCard) return false;
    if (selectedCard.hasGallery) return true;
    if (cardDetails.gallery.length > 0) return true;
    if (cardDetails.galleryError) return true;
    return false;
  }, [selectedCard, cardDetails.gallery.length, cardDetails.galleryError]);

  const activeAuthor = useMemo(() => (selectedCard?.author || "").trim(), [selectedCard?.author]);
  const activeAuthorDisplay = activeAuthor || "Unknown";
  const activeAuthorClickable = activeAuthor.length > 0;

  return {
    selectedCard,
    cardDetails,
    detailsLoading,
    galleryLoading,
    galleryMessage,
    setGalleryMessage,
    setGalleryLoading,
    cachedAssetsDetails,
    cachedAssetsLoading,
    assetCacheStatus,
    setAssetCacheStatus,
    assetCacheMessage,
    setAssetCacheMessage,
    openCardDetails,
    closeCardDetails,
    setSelectedCard,
    setCardDetails,
    refreshCachedAssets,
    pngData,
    definitionData,
    resolveTextField,
    tokenCounts,
    textSections,
    alternateGreetings,
    lorebookEntries,
    linkedLorebooks,
    galleryAssets,
    shouldShowGallerySection,
    activeAuthor,
    activeAuthorDisplay,
    activeAuthorClickable,
  };
}
