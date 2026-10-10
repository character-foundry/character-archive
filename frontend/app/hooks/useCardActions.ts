import { useState, useCallback, useEffect } from "react";
import {
  toggleFavorite,
  deleteCard as deleteCardApi,
  refreshCard as refreshCardApi,
  bulkDeleteCards,
  cacheCardAssets as cacheCardAssetsApi,
  getCachedAssets,
  exportCard,
  pushCardToSilly,
  pushCardToArchitect,
  fetchCardGallery,
} from "@/lib/api";
import type { Card, ToggleFavoriteResponse, GalleryAsset, Config } from "@/lib/types";

interface UseCardActionsResult {
  // Refresh state
  refreshingCardId: string | null;
  bulkRefreshing: boolean;
  refreshStatus: { cardId: string; type: "success" | "error"; message: string } | null;
  // Push state
  pushStatus: { cardId: string; type: "success" | "error"; message: string } | null;
  setPushStatus: (status: { cardId: string; type: "success" | "error"; message: string } | null) => void;
  // Caching state
  cachingAssets: boolean;
  // Actions
  toggleFavoriteCard: (
    card: Card,
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setSelectedCard: React.Dispatch<React.SetStateAction<Card | null>>;
      setCardDetails: React.Dispatch<React.SetStateAction<any>>;
      setGalleryLoading: (loading: boolean) => void;
      setGalleryMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
      setAssetCacheStatus: (status: { cached: boolean; count: number } | null) => void;
    }
  ) => Promise<void>;
  deleteCard: (
    card: Card,
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setCount: React.Dispatch<React.SetStateAction<number>>;
      setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
    }
  ) => Promise<void>;
  handleRefreshCard: (
    card: Card,
    loadCards: () => Promise<any>,
    openCardDetails: (card: Card) => Promise<void>,
    mode?: "local" | "source"
  ) => Promise<void>;
  handleBulkDelete: (
    selectedIds: string[],
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setCount: React.Dispatch<React.SetStateAction<number>>;
      clearSelection: () => void;
    }
  ) => Promise<void>;
  handleBulkRefresh: (
    selectedIds: string[],
    callbacks: {
      loadCards: () => Promise<any>;
      selectedCard: Card | null;
      setSelectedCard: React.Dispatch<React.SetStateAction<Card | null>>;
    }
  ) => Promise<void>;
  handleCacheAssets: (
    card: Card,
    callbacks: {
      setAssetCacheStatus: (status: { cached: boolean; count: number } | null) => void;
      setAssetCacheMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
    }
  ) => Promise<void>;
  handleExportCard: (card: Card, useLocal: boolean) => Promise<void>;
  handleDownload: (card: Card) => Promise<void>;
  handleCopyLink: (card: Card) => void;
  handlePushToSilly: (card: Card, canPush: boolean, onCacheAssets?: () => void) => Promise<void>;
  handlePushToArchitect: (card: Card, canPush: boolean) => Promise<void>;
  getSourceUrl: (card: Card) => string | null;
  getChubUrl: (card: Card) => string | null;  // Alias for backwards compatibility
  formatTokenKey: (key: string) => string;
}

export function useCardActions(): UseCardActionsResult {
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<{
    cardId: string;
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [pushStatus, setPushStatus] = useState<{
    cardId: string;
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [cachingAssets, setCachingAssets] = useState(false);

  // Auto-clear refresh status after 4s
  useEffect(() => {
    if (!refreshStatus) return;
    const timer = setTimeout(() => setRefreshStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [refreshStatus]);

  const toggleFavoriteCard = useCallback(async (
    card: Card,
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setSelectedCard: React.Dispatch<React.SetStateAction<Card | null>>;
      setCardDetails: React.Dispatch<React.SetStateAction<any>>;
      setGalleryLoading: (loading: boolean) => void;
      setGalleryMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
      setAssetCacheStatus: (status: { cached: boolean; count: number } | null) => void;
    }
  ) => {
    const { setCards, setSelectedCard, setCardDetails, setGalleryLoading, setGalleryMessage, setAssetCacheStatus } = callbacks;

    try {
      const result: ToggleFavoriteResponse = await toggleFavorite(card.id);

      setCards(prev =>
        prev.map(c =>
          c.id === card.id
            ? { ...c, favorited: result.favorited, hasGallery: !!result.hasGallery }
            : c
        )
      );
      setSelectedCard(prev =>
        prev && prev.id === card.id
          ? { ...prev, favorited: result.favorited, hasGallery: !!result.hasGallery }
          : prev
      );

      if (result.favorited === 1) {
        setGalleryLoading(true);
        setGalleryMessage(null);
        try {
          const galleryResponse = await fetchCardGallery(card.id);
          setCardDetails((prev: any) =>
            prev
              ? {
                  ...prev,
                  gallery: galleryResponse?.assets ?? [],
                  galleryError:
                    galleryResponse && galleryResponse.success === false
                      ? galleryResponse.error || "Unable to load gallery"
                      : null,
                }
              : prev
          );

          if (result.gallery?.error) {
            setGalleryMessage({ type: "error", message: result.gallery.error });
          } else if (galleryResponse?.assets?.length) {
            const cached = result.gallery?.cached ?? 0;
            const skipped = result.gallery?.skipped ?? 0;
            const messageParts: string[] = [];
            if (cached > 0) messageParts.push(`${cached} new`);
            if (skipped > 0) messageParts.push(`${skipped} existing`);
            const suffix = messageParts.length > 0 ? ` (${messageParts.join(", ")})` : "";
            setGalleryMessage({ type: "success", message: `Gallery cached${suffix}` });
          } else if (result.gallery?.message) {
            setGalleryMessage({ type: "error", message: result.gallery.message });
          } else {
            setGalleryMessage({ type: "error", message: "No gallery items available" });
          }

          // Auto-cache assets when favorited
          setCachingAssets(true);
          try {
            const cacheResult = await cacheCardAssetsApi(card.id);
            if (cacheResult.success) {
              const assets = await getCachedAssets(card.id);
              setAssetCacheStatus({ cached: true, count: assets.assets?.length || 0 });
            }
          } catch (err) {
            console.error("Failed to cache assets:", err);
          } finally {
            setCachingAssets(false);
          }
        } catch (galleryError: any) {
          const message = galleryError?.message || "Failed to load gallery";
          setCardDetails((prev: any) => (prev ? { ...prev, gallery: [], galleryError: message } : prev));
          setGalleryMessage({ type: "error", message });
        } finally {
          setGalleryLoading(false);
        }
      } else {
        setCardDetails((prev: any) => (prev ? { ...prev, gallery: [], galleryError: null } : prev));
        if (result.gallery?.removed) {
          setGalleryMessage({ type: "success", message: `Gallery cache cleared (${result.gallery.removed})` });
        } else {
          setGalleryMessage(null);
        }
      }
    } catch (err: any) {
      console.error(err);
      setGalleryMessage({ type: "error", message: err?.message || "Failed to toggle favorite" });
    }
  }, []);

  const deleteCard = useCallback(async (
    card: Card,
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setCount: React.Dispatch<React.SetStateAction<number>>;
      setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
    }
  ) => {
    if (!window.confirm(`Delete ${card.name}?`)) return;
    const { setCards, setCount, setSelectedIds } = callbacks;

    try {
      await deleteCardApi(card.id);
      setCards(prev => prev.filter(c => c.id !== card.id));
      setCount(prev => Math.max(0, prev - 1));
      setSelectedIds(prev => prev.filter(id => id !== card.id));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const handleRefreshCard = useCallback(async (
    card: Card,
    loadCards: () => Promise<any>,
    openCardDetails: (card: Card) => Promise<void>,
    mode: "local" | "source" = "local"
  ) => {
    setRefreshingCardId(card.id);
    setRefreshStatus(null);
    try {
      let updatedCard = card;
      if (mode === "source") {
        await refreshCardApi(card.id);
        const response = await loadCards();
        updatedCard = response?.cards?.find((c: Card) => c.id === card.id) || card;
      }
      await openCardDetails(updatedCard);
      setRefreshStatus({
        cardId: card.id,
        type: "success",
        message: mode === "source" ? "Updated from source" : "Reloaded saved card",
      });
    } catch (err) {
      console.error(err);
      setRefreshStatus({
        cardId: card.id,
        type: "error",
        message: err instanceof Error ? err.message : "Failed to reload card",
      });
    } finally {
      setRefreshingCardId(null);
    }
  }, []);

  const handleBulkDelete = useCallback(async (
    selectedIds: string[],
    callbacks: {
      setCards: React.Dispatch<React.SetStateAction<Card[]>>;
      setCount: React.Dispatch<React.SetStateAction<number>>;
      clearSelection: () => void;
    }
  ) => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} selected card(s)?`)) return;
    const { setCards, setCount, clearSelection } = callbacks;

    try {
      await bulkDeleteCards(selectedIds);
      setCards(prev => prev.filter(card => !selectedIds.includes(card.id)));
      setCount(prev => Math.max(0, prev - selectedIds.length));
      clearSelection();
    } catch (err) {
      console.error(err);
    }
  }, []);

  const handleBulkRefresh = useCallback(async (
    selectedIds: string[],
    callbacks: {
      loadCards: () => Promise<any>;
      selectedCard: Card | null;
      setSelectedCard: React.Dispatch<React.SetStateAction<Card | null>>;
    }
  ) => {
    if (selectedIds.length === 0) return;
    const { loadCards, selectedCard, setSelectedCard } = callbacks;

    setBulkRefreshing(true);
    setRefreshStatus(null);
    try {
      for (const cardId of selectedIds) {
        await refreshCardApi(cardId);
      }
      const response = await loadCards();
      if (response?.cards && selectedCard) {
        const updated = response.cards.find((card: Card) => card.id === selectedCard.id);
        if (updated) {
          setSelectedCard(updated);
        }
      }
      const countLabel = selectedIds.length === 1 ? "card" : "cards";
      setRefreshStatus({
        cardId: selectedIds[selectedIds.length - 1],
        type: "success",
        message: `Updated ${selectedIds.length} ${countLabel} from source`,
      });
    } catch (err: any) {
      console.error(err);
      setRefreshStatus({
        cardId: selectedIds[0],
        type: "error",
        message: err?.message || "Failed to update selected cards from source",
      });
    } finally {
      setBulkRefreshing(false);
    }
  }, []);

  const handleCacheAssets = useCallback(async (
    card: Card,
    callbacks: {
      setAssetCacheStatus: (status: { cached: boolean; count: number } | null) => void;
      setAssetCacheMessage: (msg: { type: "success" | "error"; message: string } | null) => void;
    }
  ) => {
    const { setAssetCacheStatus, setAssetCacheMessage } = callbacks;

    setCachingAssets(true);
    setAssetCacheMessage(null);
    try {
      const result = await cacheCardAssetsApi(card.id);
      if (result.success) {
        const message = result.cached > 0
          ? `Cached ${result.cached} asset(s). ${result.skipped > 0 ? `${result.skipped} already cached. ` : ""}${result.failed > 0 ? `${result.failed} failed.` : ""}`
          : result.total === 0
          ? "No media URLs found in card"
          : `All ${result.total} asset(s) already cached`;
        setAssetCacheMessage({ type: "success", message });

        const assets = await getCachedAssets(card.id);
        setAssetCacheStatus({ cached: true, count: assets.assets?.length || 0 });
      } else {
        setAssetCacheMessage({ type: "error", message: result.error || "Failed to cache assets" });
      }
    } catch (err: any) {
      console.error(err);
      setAssetCacheMessage({ type: "error", message: err.message || "Failed to cache assets" });
    } finally {
      setCachingAssets(false);
    }
  }, []);

  const handleExportCard = useCallback(async (card: Card, useLocal: boolean) => {
    try {
      const { blob, filename } = await exportCard(card.id, useLocal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error(err);
      alert(`Export failed: ${err.message}`);
    }
  }, []);

  const getDownloadFilename = useCallback((card: Card) => {
    const base = (card.name || "card")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const slug = base || "card";
    return `${slug}_${card.id}.png`;
  }, []);

  const handleDownload = useCallback(async (card: Card) => {
    try {
      let downloadUrl = card.imagePath;
      let filename = getDownloadFilename(card);

      if (card.source === "risuai") {
        // RisuAI cards: try CharX first, then full PNG (.card.png), then regular PNG
        const prefix = card.id.substring(0, 2);
        const charxUrl = `/static/${prefix}/${card.id}.charx`;
        const fullPngUrl = `/static/${prefix}/${card.id}.card.png`;
        const pngUrl = `/static/${prefix}/${card.id}.png`;

        // Check which format exists (in priority order)
        try {
          const charxCheck = await fetch(charxUrl, { method: 'HEAD' });
          if (charxCheck.ok) {
            downloadUrl = charxUrl;
            filename = filename.replace(/\.png$/, '.charx');
          } else {
            // Try full PNG with embedded assets
            const fullPngCheck = await fetch(fullPngUrl, { method: 'HEAD' });
            if (fullPngCheck.ok) {
              downloadUrl = fullPngUrl;
              // filename stays as .png
            } else {
              downloadUrl = pngUrl;
            }
          }
        } catch {
          downloadUrl = pngUrl;
        }
      }

      const response = await fetch(downloadUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }, [getDownloadFilename]);

  const handleCopyLink = useCallback((card: Card) => {
    const url = `${window.location.origin}${card.imagePath}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).catch(console.error);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch (err) {
        console.error("Failed to copy:", err);
      }
      document.body.removeChild(textarea);
    }
  }, []);

  const handlePushToSilly = useCallback(async (card: Card, canPush: boolean, onCacheAssets?: () => void) => {
    if (!canPush) {
      setPushStatus({
        cardId: card.id,
        type: "error",
        message: "Enable Silly Tavern integration in settings before pushing.",
      });
      return;
    }
    try {
      const result = await pushCardToSilly(card.id);
      const status = (result as any)?.status ? ` (status ${(result as any).status})` : "";
      const responseMessage = (result as any)?.response?.message || (result as any)?.message;
      const message =
        responseMessage || `Pushed card ${card.name || card.id} to Silly Tavern${status}`;
      setPushStatus({ cardId: card.id, type: "success", message });

      onCacheAssets?.();
    } catch (err: any) {
      setPushStatus({
        cardId: card.id,
        type: "error",
        message: err?.message || "Failed to push card to Silly Tavern",
      });
    }
  }, []);

  const handlePushToArchitect = useCallback(async (card: Card, canPush: boolean) => {
    if (!canPush) {
      setPushStatus({
        cardId: card.id,
        type: "error",
        message: "Configure Character Architect URL in settings before pushing.",
      });
      return;
    }
    try {
      const result = await pushCardToArchitect(card.id);
      const responseMessage = (result as any)?.message;
      const message =
        responseMessage || `Pushed card ${card.name || card.id} to Character Architect`;
      setPushStatus({ cardId: card.id, type: "success", message });
    } catch (err: any) {
      setPushStatus({
        cardId: card.id,
        type: "error",
        message: err?.message || "Failed to push card to Character Architect",
      });
    }
  }, []);

  /**
   * Get the source URL for a card (to view on original platform)
   * Works for all sources: Chub, CT, RisuAI, Wyvern
   */
  const getSourceUrl = useCallback((card: Card) => {
    // All scrapers now set sourceUrl - use it if available
    if (card.sourceUrl) {
      return card.sourceUrl;
    }
    // Fallback for legacy Chub cards without sourceUrl
    if (card.fullPath) {
      return `https://chub.ai/characters/${card.fullPath}`;
    }
    // Last resort fallback
    if (card.silly_link) {
      return card.silly_link;
    }
    return null;
  }, []);

  // Alias for backwards compatibility
  const getChubUrl = getSourceUrl;

  const formatTokenKey = useCallback((key: string) =>
    key
      .split("_")
      .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join(" "),
  []);

  return {
    refreshingCardId,
    bulkRefreshing,
    refreshStatus,
    pushStatus,
    setPushStatus,
    cachingAssets,
    toggleFavoriteCard,
    deleteCard,
    handleRefreshCard,
    handleBulkDelete,
    handleBulkRefresh,
    handleCacheAssets,
    handleExportCard,
    handleDownload,
    handleCopyLink,
    handlePushToSilly,
    handlePushToArchitect,
    getSourceUrl,
    getChubUrl,
    formatTokenKey,
  };
}
