"use client";

import { useCallback, useEffect, useMemo, useState, Suspense, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { fetchTagAliases } from "@/lib/api";
import type { Card } from "@/lib/types";
import { Loader2, Sparkles } from "lucide-react";
import { CardModal } from "./components/CardModal";
import { CardItem } from "./components/CardItem";
import { FilterBar } from "./components/FilterBar";
import { PaginationHeader } from "./components/PaginationHeader";
import { PaginationControls } from "./components/PaginationControls";
import { BulkActionBar } from "./components/BulkActionBar";
import { SyncStatus, PushNotification } from "./components/StatusBanners";
import { SettingsModal } from "./components/SettingsModal";
import { FederationModal } from "./components/FederationModal";
import { defaultFilters, normalizeFilters } from "./types/filters";
import { defaultSillyTavernState, defaultCtSyncState, defaultVectorSearchState, defaultWyvernSyncState } from "./types/config";
import { parseTagString } from "./utils/tags";
import { useLightbox } from "./hooks/useLightbox";
import { useCardSelection } from "./hooks/useCardSelection";
import { useConfig } from "./hooks/useConfig";
import { useSync } from "./hooks/useSync";
import { useCardData } from "./hooks/useCardData";
import { useFilters } from "./hooks/useFilters";
import { useCardDetails } from "./hooks/useCardDetails";
import { useCardActions } from "./hooks/useCardActions";
import { useSavedSearches } from "./hooks/useSavedSearches";
import { resolveUrlCard } from "./utils/urlCard";

function HomeContent() {
  const searchParams = useSearchParams();
  const [darkMode, setDarkMode] = useState(false);
  const [showFederation, setShowFederation] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagAliases, setTagAliases] = useState<Record<string, string[]> | null>(null);
  const [isFetchingChubFollows, setIsFetchingChubFollows] = useState(false);
  const [chubFollowStatus, setChubFollowStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isFetchingChubBlocked, setIsFetchingChubBlocked] = useState(false);
  const [chubBlockedStatus, setChubBlockedStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const chubProfileInputRef = useRef<HTMLInputElement | null>(null);
  const followedCreatorsTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const blockedCreatorsTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Selection management
  const selection = useCardSelection();
  const { selectedIds, isSelected: isCardSelected, clearSelection, selectAll: selectAllCards, toggleSelection, setSelectedIds } = selection;

  // Config management
  const configManager = useConfig();
  const { config, setConfig, showSettings, setShowSettings, loading: configLoading, saveStatus: configSaveStatus, saveConfig: handleSaveConfig } = configManager;

  // Filters management
  const filtersManager = useFilters(undefined, clearSelection);
  const {
    filters, setFilters, searchInputValue, setSearchInputValue, advancedFilterInput, setAdvancedFilterInput,
    includeTagsSelected, excludeTagsSelected, highlightedTags, highlightedTagsSet, page, setPage,
    handleFilterChange, handleIncludeTagsChange, handleExcludeTagsChange,
    handleClearFilters, updateURL, getCardIdFromURL,
  } = filtersManager;

  // Card data management - pass page from filters hook
  const cardData = useCardData(filters, page);
  const { cards, totalPages, count, vectorMeta, isLoading, error, loadCards, setCards, setCount } = cardData;

  // Card details management
  const cardDetailsManager = useCardDetails(cards, setCards);
  const {
    selectedCard, cardDetails, detailsLoading, galleryLoading, galleryMessage, setGalleryMessage, setGalleryLoading,
    cachedAssetsDetails, cachedAssetsLoading, assetCacheStatus, setAssetCacheStatus, assetCacheMessage, setAssetCacheMessage,
    openCardDetails, closeCardDetails, setSelectedCard, setCardDetails, tokenCounts, textSections,
    alternateGreetings, lorebookEntries, linkedLorebooks, galleryAssets, shouldShowGallerySection,
    activeAuthor, activeAuthorDisplay, activeAuthorClickable,
  } = cardDetailsManager;

  // Card actions
  const cardActions = useCardActions();
  const {
    refreshingCardId, bulkRefreshing, refreshStatus, pushStatus, setPushStatus, cachingAssets,
    toggleFavoriteCard, deleteCard, handleRefreshCard, handleBulkDelete, handleBulkRefresh,
    handleCacheAssets, handleExportCard, handleDownload, handleCopyLink,
    handlePushToSilly, handlePushToArchitect, getChubUrl, formatTokenKey,
  } = cardActions;

  // Saved searches
  const savedSearchesManager = useSavedSearches();
  const { savedSearches, handleSaveSearch, applySavedSearch, removeSavedSearch } = savedSearchesManager;

  // Lightbox
  const lightbox = useLightbox(galleryAssets, selectedCard?.id);

  // Sync management
  const sync = useSync(loadCards);
  const {
    syncing, syncStatus, startChubSync: startSyncing,
    ctSyncing, ctSyncStatus, startCtSync: startCtSyncing,
    wyvernSyncing, wyvernSyncStatus, startWyvernSync,
    risuSyncing, risuSyncStatus, startRisuSync,
    anySyncing, latestSyncRun, cancelAllSyncs,
  } = sync;

  // Computed values
  const hasFollowedCreators = useMemo(() => (config?.followedCreators?.length || 0) > 0, [config?.followedCreators]);
  const canPushToSilly = useMemo(() => !!(config?.sillyTavern?.enabled && config?.sillyTavern?.baseUrl), [config?.sillyTavern?.enabled, config?.sillyTavern?.baseUrl]);
  const canPushToArchitect = useMemo(() => !!config?.characterArchitect?.url, [config?.characterArchitect?.url]);
  const pageLabel = useMemo(() => `${page} of ${totalPages} | ${count.toLocaleString()} Cards`, [page, totalPages, count]);

  const pushMessage = useMemo(() => pushStatus && selectedCard && pushStatus.cardId === selectedCard.id ? pushStatus : null, [pushStatus, selectedCard]);
  const globalPushMessage = useMemo(() => pushStatus && (!selectedCard || pushStatus.cardId !== selectedCard.id) ? pushStatus : null, [pushStatus, selectedCard]);
  const pushedCard = useMemo(() => {
    if (!pushStatus) return null;
    if (selectedCard && selectedCard.id === pushStatus.cardId) return selectedCard;
    return cards.find(card => card.id === pushStatus.cardId) || null;
  }, [pushStatus, selectedCard, cards]);

  const canonicalTagSet = useMemo(() => {
    if (!tagAliases) return undefined;
    return new Set(Object.keys(tagAliases).map(tag => tag.toLowerCase()));
  }, [tagAliases]);

  const computedTagSuggestions = useMemo(() => {
    const tags = new Set<string>([...includeTagsSelected, ...excludeTagsSelected]);
    cards.forEach(card => card.topics.forEach(tag => tags.add(tag)));
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [cards, includeTagsSelected, excludeTagsSelected]);

  // Load tag aliases on mount
  useEffect(() => {
    let cancelled = false;
    fetchTagAliases()
      .then(({ aliases }) => { if (!cancelled) setTagAliases(aliases); })
      .catch(err => console.error("Failed to load tag aliases", err));
    return () => { cancelled = true; };
  }, []);

  // Sync tag suggestions
  useEffect(() => { setTagSuggestions(computedTagSuggestions); }, [computedTagSuggestions]);

  // Dark mode toggle
  useEffect(() => { document.documentElement.classList.toggle("dark", darkMode); }, [darkMode]);

  // Clear selection when cards change
  useEffect(() => {
    const cardIdSet = new Set(cards.map(card => card.id));
    setSelectedIds(prev => prev.filter(id => cardIdSet.has(id)));
  }, [cards, setSelectedIds]);

  // Reset chub follow status when settings close
  useEffect(() => {
    if (!showSettings) {
      setChubFollowStatus(null);
      setIsFetchingChubFollows(false);
    }
  }, [showSettings]);

  const urlCardId = getCardIdFromURL();
  const lastUrlCardIdRef = useRef<string | null>(null);
  useEffect(() => {
    const result = resolveUrlCard(urlCardId, cards, lastUrlCardIdRef.current);
    if (result.action === "clear") {
      lastUrlCardIdRef.current = result.nextLast;
      setSelectedCard(null);
      return;
    }
    if (result.action === "open") {
      lastUrlCardIdRef.current = result.nextLast;
      openCardDetails(result.card);
    }
    // action "none" falls through
  }, [urlCardId, cards, openCardDetails, setSelectedCard]);

  // Handlers with proper callbacks
  const handleTagClick = useCallback(async (tag: string) => {
    const cleaned = tag.trim();
    if (!cleaned) return;
    const newFilters = normalizeFilters({ ...filters, includeTags: cleaned, searchTerm: "" });
    setFilters(newFilters);
    setSearchInputValue("");
    setPage(1);
    clearSelection();
    setSelectedCard(null);
    updateURL(newFilters, 1, null, true);
    await loadCards();
  }, [filters, setFilters, setSearchInputValue, setPage, clearSelection, setSelectedCard, updateURL, loadCards]);

  const handleAuthorClick = useCallback((author: string | undefined | null) => {
    const cleaned = (author || "").trim();
    if (!cleaned) return;
    const escapedAuthor = cleaned.replace(/"/g, '\\"');
    const authorFilter = `author = "${escapedAuthor}"`;
    const newFilters = normalizeFilters({ ...filters, searchTerm: "", includeTags: "", excludeTags: "", advancedFilter: authorFilter });
    setFilters(newFilters);
    setSearchInputValue("");
    setAdvancedFilterInput(authorFilter);
    setPage(1);
    clearSelection();
    setSelectedCard(null);
    updateURL(newFilters, 1, null, true);
  }, [filters, setFilters, setSearchInputValue, setAdvancedFilterInput, setPage, clearSelection, setSelectedCard, updateURL]);

  const handleCloseCard = useCallback(() => {
    closeCardDetails(() => updateURL(filters, page, null));
    if (pushStatus && pushStatus.cardId === selectedCard?.id) {
      setPushStatus(null);
    }
  }, [closeCardDetails, updateURL, filters, page, selectedCard?.id, setPushStatus, pushStatus]);

  const handleOpenCard = useCallback(async (card: Card) => {
    await openCardDetails(card, (cardId) => updateURL(filters, page, cardId, true));
  }, [openCardDetails, updateURL, filters, page]);

  // Navigation handlers
  const handleNavigateBack = useCallback(() => {
    if (page <= 1) return;
    setPage(page - 1);
    clearSelection();
    setSelectedCard(null);
    updateURL(filters, page - 1, null, true);
  }, [page, setPage, clearSelection, setSelectedCard, updateURL, filters]);

  const handleNavigateForward = useCallback(() => {
    if (page >= totalPages) return;
    setPage(page + 1);
    clearSelection();
    setSelectedCard(null);
    updateURL(filters, page + 1, null, true);
  }, [page, totalPages, setPage, clearSelection, setSelectedCard, updateURL, filters]);

  const handleGoToFirstPage = useCallback(() => {
    if (page === 1) return;
    setPage(1);
    clearSelection();
    setSelectedCard(null);
    updateURL(filters, 1, null, true);
  }, [page, setPage, clearSelection, setSelectedCard, updateURL, filters]);

  const handleGoToLastPage = useCallback(() => {
    if (page === totalPages) return;
    setPage(totalPages);
    clearSelection();
    setSelectedCard(null);
    updateURL(filters, totalPages, null, true);
  }, [page, totalPages, setPage, clearSelection, setSelectedCard, updateURL, filters]);

  // Bulk actions
  const handleSelectAll = () => selectAllCards(cards);
  const handleBulkDeleteAction = () => handleBulkDelete(selectedIds, { setCards, setCount, clearSelection });
  const handleBulkRefreshAction = () => handleBulkRefresh(selectedIds, { loadCards, selectedCard, setSelectedCard });

  // Card actions wrappers
  const wrapToggleFavorite = (card: Card) => toggleFavoriteCard(card, { setCards, setSelectedCard, setCardDetails, setGalleryLoading, setGalleryMessage, setAssetCacheStatus });
  const wrapDeleteCard = (card: Card) => deleteCard(card, { setCards, setCount, setSelectedIds });
  const wrapRefreshCard = (card: Card) => handleRefreshCard(card, loadCards, handleOpenCard);
  const wrapCacheAssets = (card: Card) => handleCacheAssets(card, { setAssetCacheStatus, setAssetCacheMessage });
  const wrapPushToSilly = (card: Card) => handlePushToSilly(card, canPushToSilly, () => wrapCacheAssets(card));
  const wrapPushToArchitect = (card: Card) => handlePushToArchitect(card, canPushToArchitect);

  const handleCardTextClick = (event: React.MouseEvent<HTMLDivElement>, card: Card, index: number) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea")) return;
    toggleSelection(card, index, event, cards);
  };

  const handleApplySavedSearch = useCallback((search: any) => {
    applySavedSearch(search, {
      setFilters,
      setPage,
      setIncludeTagsSelected: () => {},
      setExcludeTagsSelected: () => {},
      setHighlightedTags: () => {},
      setSearchInputValue,
      setAdvancedFilterInput,
      updateURL,
    });
  }, [applySavedSearch, setFilters, setPage, setSearchInputValue, setAdvancedFilterInput, updateURL]);

  const handleFetchChubFollows = async () => {
    const { fetchChubFollows } = await import("@/lib/api");
    const fromInput = chubProfileInputRef.current?.value?.trim();
    const profile = (fromInput || config?.chubProfileName || "").trim();
    if (!profile) {
      setChubFollowStatus({ type: "error", message: "Enter your Chub profile name first." });
      return;
    }
    setIsFetchingChubFollows(true);
    setChubFollowStatus(null);
    try {
      const result = await fetchChubFollows(profile);
      const usernames = Array.isArray(result.creators)
        ? result.creators.map(c => c.username).filter(u => typeof u === "string" && u.trim().length > 0)
        : [];
      if (followedCreatorsTextareaRef.current) followedCreatorsTextareaRef.current.value = usernames.join(", ");
      if (chubProfileInputRef.current) chubProfileInputRef.current.value = result.profile;
      setConfig(prev => prev ? { ...prev, chubProfileName: result.profile, followedCreators: usernames } : prev);
      setChubFollowStatus({ type: "success", message: `Loaded ${usernames.length} creator${usernames.length === 1 ? "" : "s"} from Chub.` });
    } catch (err: any) {
      setChubFollowStatus({ type: "error", message: err?.message || "Failed to fetch followed creators." });
    } finally {
      setIsFetchingChubFollows(false);
    }
  };

  const handleFetchChubBlocked = async () => {
    const { fetchChubBlockedUsers } = await import("@/lib/api");
    setIsFetchingChubBlocked(true);
    setChubBlockedStatus(null);
    try {
      const result = await fetchChubBlockedUsers();
      const usernames = Array.isArray(result.blockedUsers)
        ? result.blockedUsers.filter(u => typeof u === "string" && u.trim().length > 0)
        : [];
      if (blockedCreatorsTextareaRef.current) blockedCreatorsTextareaRef.current.value = usernames.join(", ");
      setConfig(prev => prev ? { ...prev, blockedCreators: usernames } : prev);
      setChubBlockedStatus({ type: "success", message: `Loaded ${usernames.length} blocked user${usernames.length === 1 ? "" : "s"} from Chub.` });
    } catch (err: any) {
      setChubBlockedStatus({ type: "error", message: err?.message || "Failed to fetch blocked users." });
    } finally {
      setIsFetchingChubBlocked(false);
    }
  };

  const renderCards = () => {
    if (isLoading) {
      return (
        <div className="flex h-64 items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading cards...
          </div>
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex h-64 items-center justify-center rounded-3xl border border-red-200 bg-red-50 text-sm text-red-600 dark:border-red-600/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      );
    }
    if (cards.length === 0) {
      return (
        <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-3xl border border-slate-200 bg-white text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <span>No cards match these filters.</span>
          <button onClick={handleClearFilters} className="rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 dark:border-slate-700 dark:text-slate-200">
            Reset filters
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {vectorMeta?.enabled && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-indigo-100 bg-indigo-50/80 px-5 py-4 text-sm text-slate-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-slate-100">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-200">
              <Sparkles className="h-4 w-4" /> Semantic search active
            </div>
            <div className="flex flex-col gap-2 text-xs text-slate-600 dark:text-slate-300 sm:flex-row sm:items-center sm:gap-4">
              <span>Cards fetched: {vectorMeta.meta?.cardsFetched ?? "—"}</span>
              <span>Chunks fetched: {vectorMeta.meta?.chunksFetched ?? "—"}</span>
              {typeof vectorMeta.meta?.semanticRatio === "number" && <span>Ratio: {Math.round(vectorMeta.meta.semanticRatio * 100)}% vector</span>}
            </div>
          </div>
        )}
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card, index) => (
            <CardItem
              key={card.id}
              card={card}
              index={index}
              isSelected={isCardSelected(card.id)}
              highlightedTagsSet={highlightedTagsSet}
              canPushToSilly={canPushToSilly}
              chubUrl={getChubUrl(card)}
              onOpenDetails={handleOpenCard}
              onCardTextClick={handleCardTextClick}
              onTagClick={handleTagClick}
              onAuthorClick={handleAuthorClick}
              onToggleFavorite={wrapToggleFavorite}
              onDownload={handleDownload}
              onPushToSilly={wrapPushToSilly}
              onCopyLink={handleCopyLink}
              onDelete={wrapDeleteCard}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-16 transition dark:bg-slate-950">
      <PaginationHeader
        page={page}
        totalPages={totalPages}
        pageLabel={pageLabel}
        isLoading={isLoading}
        syncing={anySyncing}
        darkMode={darkMode}
        onGoToFirstPage={handleGoToFirstPage}
        onNavigateBack={handleNavigateBack}
        onNavigateForward={handleNavigateForward}
        onGoToLastPage={handleGoToLastPage}
        onRefresh={() => loadCards()}
        onSaveSearch={() => handleSaveSearch(filters, includeTagsSelected, excludeTagsSelected)}
        onSync={async () => {
          await startSyncing();
        }}
        onOpenFederation={() => setShowFederation(true)}
        onOpenSettings={() => setShowSettings(true)}
        onToggleDarkMode={() => setDarkMode(prev => !prev)}
      />

      <header className="mx-auto w-full max-w-7xl px-6 pt-6 pb-2">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Character Archive</h1>
          <SyncStatus syncStatus={syncStatus} ctSyncStatus={ctSyncStatus} />
        </div>
      </header>

      <PushNotification message={globalPushMessage} cardName={pushedCard?.name} onDismiss={() => setPushStatus(null)} />

      <main className="mx-auto w-full max-w-7xl space-y-6 px-6">
        <FilterBar
          filters={filters}
          searchInputValue={searchInputValue}
          advancedFilterInput={advancedFilterInput}
          includeTagsSelected={includeTagsSelected}
          excludeTagsSelected={excludeTagsSelected}
          tagSuggestions={tagSuggestions}
          savedSearches={savedSearches}
          darkMode={darkMode}
          hasFollowedCreators={hasFollowedCreators}
          canonicalTagSet={canonicalTagSet}
          onSearchInputChange={setSearchInputValue}
          onAdvancedFilterChange={setAdvancedFilterInput}
          onIncludeTagsChange={handleIncludeTagsChange}
          onExcludeTagsChange={handleExcludeTagsChange}
          onFilterChange={handleFilterChange}
          onSearchSubmit={(e) => e.preventDefault()}
          onClearFilters={handleClearFilters}
          onSaveSearch={() => handleSaveSearch(filters, includeTagsSelected, excludeTagsSelected)}
          onApplySavedSearch={handleApplySavedSearch}
          onRemoveSavedSearch={removeSavedSearch}
        />

        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <BulkActionBar
            selectedCount={selectedIds.length}
            bulkRefreshing={bulkRefreshing}
            onSelectAll={handleSelectAll}
            onClearSelection={clearSelection}
            onBulkRefresh={handleBulkRefreshAction}
            onBulkDelete={handleBulkDeleteAction}
          />
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-100">
              <span className="font-semibold">{selectedIds.length} selected</span>
              <span className="text-xs uppercase tracking-wide">Use Ctrl/Cmd for multi-select, Shift for ranges.</span>
            </div>
          )}
          {renderCards()}
          {totalPages > 1 && (
            <div className="flex items-center justify-between rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              <PaginationControls page={page} totalPages={totalPages} size="sm" onFirst={handleGoToFirstPage} onPrev={handleNavigateBack} onNext={handleNavigateForward} onLast={handleGoToLastPage} />
              <span className="text-xs font-medium">{pageLabel}</span>
              <div className="w-[140px]"></div>
            </div>
          )}
        </section>
      </main>

      <CardModal
        selectedCard={selectedCard}
        closeCardDetails={handleCloseCard}
        getChubUrl={getChubUrl}
        refreshStatus={refreshStatus}
        toggleFavoriteCard={wrapToggleFavorite}
        handleRefreshCard={wrapRefreshCard}
        refreshingCardId={refreshingCardId}
        handleDownload={handleDownload}
        handlePushToSilly={wrapPushToSilly}
        canPushToSilly={canPushToSilly}
        handlePushToArchitect={wrapPushToArchitect}
        canPushToArchitect={canPushToArchitect}
        handleCopyLink={handleCopyLink}
        handleCacheAssets={wrapCacheAssets}
        cachingAssets={cachingAssets}
        assetCacheStatus={assetCacheStatus}
        handleExportCard={handleExportCard}
        assetCacheMessage={assetCacheMessage}
        galleryMessage={galleryMessage}
        pushMessage={pushMessage}
        detailsLoading={detailsLoading}
        cardDetails={cardDetails}
        tokenCounts={tokenCounts}
        formatTokenKey={formatTokenKey}
        textSections={textSections}
        alternateGreetings={alternateGreetings}
        lorebookEntries={lorebookEntries}
        linkedLorebooks={linkedLorebooks}
        shouldShowGallerySection={shouldShowGallerySection}
        galleryAssets={galleryAssets}
        galleryLoading={galleryLoading}
        openLightbox={lightbox.open}
        cachedAssetsDetails={cachedAssetsDetails}
        cachedAssetsLoading={cachedAssetsLoading}
        activeAuthorClickable={activeAuthorClickable}
        activeAuthor={activeAuthor}
        activeAuthorDisplay={activeAuthorDisplay}
        handleAuthorClick={handleAuthorClick}
        highlightedTagsSet={highlightedTagsSet}
        handleTagClick={handleTagClick}
        activeLightboxAsset={lightbox.asset}
        closeLightbox={lightbox.close}
        showPrevAsset={lightbox.prev}
        showNextAsset={lightbox.next}
        lightboxIndex={lightbox.index}
      />
      <SettingsModal
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        config={config}
        handleSaveConfig={handleSaveConfig}
        configLoading={configLoading}
        configSaveStatus={configSaveStatus}
        chubProfileInputRef={chubProfileInputRef}
        followedCreatorsTextareaRef={followedCreatorsTextareaRef}
        handleFetchChubFollows={handleFetchChubFollows}
        isFetchingChubFollows={isFetchingChubFollows}
        chubFollowStatus={chubFollowStatus}
        blockedCreatorsTextareaRef={blockedCreatorsTextareaRef}
        handleFetchChubBlocked={handleFetchChubBlocked}
        isFetchingChubBlocked={isFetchingChubBlocked}
        chubBlockedStatus={chubBlockedStatus}
        defaultSillyTavernState={defaultSillyTavernState}
        defaultCtSyncState={defaultCtSyncState}
        defaultVectorSearchState={defaultVectorSearchState}
        // Sync test functions
        startChubSync={startSyncing}
        chubSyncing={syncing}
        chubSyncStatus={syncStatus}
        startCtSync={startCtSyncing}
        ctSyncing={ctSyncing}
        ctSyncStatus={ctSyncStatus}
        startWyvernSync={startWyvernSync}
        wyvernSyncing={wyvernSyncing}
        wyvernSyncStatus={wyvernSyncStatus}
        startRisuSync={startRisuSync}
        risuSyncing={risuSyncing}
        risuSyncStatus={risuSyncStatus}
        defaultWyvernSyncState={defaultWyvernSyncState}
        anySyncing={anySyncing}
        latestSyncRun={latestSyncRun}
        cancelAllSyncs={cancelAllSyncs}
      />
      <FederationModal
        show={showFederation}
        onClose={() => setShowFederation(false)}
      />
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}>
      <HomeContent />
    </Suspense>
  );
}
