import { useState, useCallback, useEffect, useRef } from "react";
import { fetchCards } from "@/lib/api";
import type { Card, CardsResponse } from "@/lib/types";
import type { FiltersState } from "../types/filters";

interface UseCardDataResult {
  cards: Card[];
  totalPages: number;
  count: number;
  vectorMeta: CardsResponse["vector"] | null;
  isLoading: boolean;
  error: string | null;
  setCards: React.Dispatch<React.SetStateAction<Card[]>>;
  setCount: React.Dispatch<React.SetStateAction<number>>;
  loadCards: () => Promise<CardsResponse | null>;
  refetch: () => Promise<CardsResponse | null>;
}

/**
 * Custom hook for managing card data fetching with pagination and abort control
 * Handles automatic refetching when filters or page change
 */
export function useCardData(
  filters: FiltersState,
  page: number = 1
): UseCardDataResult {
  const [cards, setCards] = useState<Card[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [count, setCount] = useState(0);
  const [vectorMeta, setVectorMeta] = useState<CardsResponse["vector"] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayedCardsRef = useRef(cards);
  useEffect(() => { displayedCardsRef.current = cards; }, [cards]);
  const cardsAbortRef = useRef<AbortController | null>(null);
  const cardsRequestIdRef = useRef(0);

  const loadCards = useCallback(async (): Promise<CardsResponse | null> => {
    cardsAbortRef.current?.abort();
    const controller = new AbortController();
    cardsAbortRef.current = controller;
    const requestId = cardsRequestIdRef.current + 1;
    cardsRequestIdRef.current = requestId;

    setIsLoading(true);
    setError(null);
    try {
      // Always use advanced search (unified search mode)
      const params: Record<string, string | number | undefined> = {
        page,
        sort: filters.sort,
        advanced: "true",  // Always use advanced/vector search
      };

      const minTokensValue = Number.parseInt(filters.minTokens, 10);
      const hasMinTokens = Number.isFinite(minTokensValue) && minTokensValue > 0;

      // Search query
      if (filters.searchTerm) {
        params.query = filters.searchTerm;
      }

      // Tag filters (backend will build unified filter expression)
      if (filters.includeTags) {
        params.include = filters.includeTags;
        params.tagMatchMode = filters.tagMatchMode;
      }
      if (filters.excludeTags) {
        params.exclude = filters.excludeTags;
      }

      // Manual advanced filter expression (for power users)
      if (filters.advancedFilter?.trim()) {
        params.advancedFilter = filters.advancedFilter.trim();
      }

      // Min tokens
      if (hasMinTokens) {
        params.minTokens = minTokensValue;
      }

      // Other filters (backend buildMeilisearchFilter handles these)
      if (filters.favorite) params.favorite = filters.favorite;
      if (filters.source && filters.source !== "all") params.source = filters.source;
      if (filters.hasExampleDialogues) params.hasExampleDialogues = "true";
      if (filters.hasAlternateGreetings) params.hasAlternateGreetings = "true";
      if (filters.hasSystemPrompt) params.hasSystemPrompt = "true";
      if (filters.hasLorebook) params.hasLorebook = "true";
      if (filters.hasEmbeddedLorebook) params.hasEmbeddedLorebook = "true";
      if (filters.hasLinkedLorebook) params.hasLinkedLorebook = "true";
      if (filters.hasGallery) params.hasGallery = "true";
      if (filters.hasEmbeddedImages) params.hasEmbeddedImages = "true";
      if (filters.hasExpressions) params.hasExpressions = "true";
      if (filters.inSillyTavern) params.inSillyTavern = "true";
      if (filters.followedOnly) params.followedOnly = "true";
      params.withSillyStatus = "true";

      const response = await fetchCards(params, controller.signal);
      if (cardsRequestIdRef.current !== requestId) {
        return null;
      }
      setCards(response.cards);
      setCount(response.count);
      setTotalPages(Math.max(1, response.totalPages || 1));
      setVectorMeta(response.vector ?? null);
      return response;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return null;
      }
      console.error(err);
      setError(err.message || "Unable to load cards");
      setVectorMeta(null);
      return null;
    } finally {
      if (cardsAbortRef.current === controller) {
        cardsAbortRef.current = null;
        setIsLoading(false);
      }
    }
  }, [filters, page]);

  // Automatically load cards when filters or page change
  useEffect(() => {
    loadCards();
  }, [loadCards]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cardsAbortRef.current) {
        cardsAbortRef.current.abort();
        cardsAbortRef.current = null;
      }
    };
  }, []);

  const favoriteIds = cards.map(card => card.id).join(',');
  useEffect(() => {
    if (!favoriteIds) return;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const previous = new Map(displayedCardsRef.current.map(card => [String(card.id), card.favorited]));
        const response = await fetch(`/api/cards/favorite-status?ids=${encodeURIComponent(favoriteIds)}`, { signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json() as { cards: Array<{ id: string | number; favorited: number }> };
        const favorites = new Map(result.cards.map(card => [String(card.id), card.favorited]));
        setCards(current => {
          let changed = false;
          const updated = current.map(card => {
            const favorite = favorites.get(String(card.id));
            if (favorite === undefined || favorite === card.favorited || previous.get(String(card.id)) !== card.favorited) return card;
            changed = true;
            return { ...card, favorited: favorite };
          });
          return changed ? updated : current;
        });
      } catch { /* A failed poll leaves the locally displayed favorite intact. */ }
    };
    const timer = setInterval(() => { void refresh(); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [favoriteIds]);

  return {
    cards,
    totalPages,
    count,
    vectorMeta,
    isLoading,
    error,
    setCards,
    setCount,
    loadCards,
    refetch: loadCards,  // Alias for convenience
  };
}
