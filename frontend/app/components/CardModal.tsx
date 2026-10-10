'use client';

import { Fragment, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import {
    X,
    Globe,
    Database,
    Loader2,
    Tag,
    Sparkles,
    BookOpen,
    Image as ImageIcon,
    Images,
    Smile,
    ArrowLeft,
    ArrowRight,
} from 'lucide-react';
import Image from 'next/image';
import clsx from 'clsx';
import { CardArtwork } from './CardArtwork';
import { CardDetailActions } from './CardDetailActions';
import { TokenSummary } from './TokenSummary';
import { CollapsibleSection, NestedSection, MarkdownContent } from './ContentSections';
import type { Card, CachedAsset } from '@/lib/types';

type MessageStatus = { type: 'success' | 'error'; message: string } | null;

type CardMetadata = Record<string, unknown>;

type CardDetails = {
    metadata: CardMetadata | null;
    galleryError: string | null;
};

type TokenCounts = Record<string, number | string | null | undefined>;

type LorebookEntry = {
    name?: string;
    keys?: string[];
    content?: string;
    commentary?: string;
};

type LinkedLorebook = {
    name?: string;
    description?: string;
    fullPath?: string;
};

type GalleryAsset = {
    id: string;
    url: string;
    thumbUrl?: string;
    title?: string;
    caption?: string;
};


type AssetCacheStatus = {
    cached: boolean;
    count: number;
} | null;

type RefreshStatus = {
    cardId: string;
    type: 'success' | 'error';
    message: string;
} | null;

type CardModalProps = {
    selectedCard: Card | null;
    closeCardDetails: () => void;
    getChubUrl: (card: Card) => string | null;
    refreshStatus: RefreshStatus;
    toggleFavoriteCard: (card: Card) => void;
    handleRefreshCard: (card: Card, mode?: "local" | "source") => void;
    refreshingCardId: string | null;
    handleDownload: (card: Card) => void;
    handlePushToSilly: (card: Card) => void;
    canPushToSilly: boolean;
    handlePushToArchitect: (card: Card) => void;
    canPushToArchitect: boolean;
    handleCopyLink: (card: Card) => void;
    handleCacheAssets: (card: Card) => void;
    cachingAssets: boolean;
    assetCacheStatus: AssetCacheStatus;
    handleExportCard: (card: Card, withLocalAssets: boolean) => void;
    assetCacheMessage: MessageStatus;
    galleryMessage: MessageStatus;
    pushMessage: MessageStatus;
    detailsLoading: boolean;
    cardDetails: CardDetails;
    tokenCounts: TokenCounts | null;
    formatTokenKey: (key: string) => string;
    textSections: Array<{ title: string; value: string }>;
    alternateGreetings: string[];
    lorebookEntries: LorebookEntry[];
    linkedLorebooks: LinkedLorebook[];
    shouldShowGallerySection: boolean;
    galleryAssets: GalleryAsset[];
    galleryLoading: boolean;
    openLightbox: (index: number) => void;
    cachedAssetsDetails: CachedAsset[];
    cachedAssetsLoading: boolean;
    activeAuthorClickable: boolean;
    activeAuthor: string;
    activeAuthorDisplay: string;
    handleAuthorClick: (author: string) => void;
    highlightedTagsSet: Set<string>;
    handleTagClick: (tag: string) => void;
    activeLightboxAsset: GalleryAsset | null;
    closeLightbox: () => void;
    showPrevAsset: () => void;
    showNextAsset: () => void;
    lightboxIndex: number | null;
};

export const CardModal = ({
    selectedCard: activeCard,
    closeCardDetails,
    getChubUrl,
    refreshStatus,
    toggleFavoriteCard,
    handleRefreshCard,
    refreshingCardId,
    handleDownload,
    handlePushToSilly,
    canPushToSilly,
    handlePushToArchitect,
    canPushToArchitect,
    handleCopyLink,
    assetCacheMessage,
    galleryMessage,
    pushMessage,
    detailsLoading,
    cardDetails,
    tokenCounts,
    formatTokenKey,
    textSections,
    alternateGreetings,
    lorebookEntries,
    linkedLorebooks,
    shouldShowGallerySection,
    galleryAssets,
    galleryLoading,
    openLightbox,
    cachedAssetsDetails,
    cachedAssetsLoading,
    activeAuthorClickable,
    activeAuthor,
    activeAuthorDisplay,
    handleAuthorClick,
    highlightedTagsSet,
    handleTagClick,
    activeLightboxAsset,
    closeLightbox,
    showPrevAsset,
    showNextAsset,
    lightboxIndex,
}: CardModalProps) => {
    // Keep the artwork and title mounted through the drawer's exit animation.
    const [lastCard, setLastCard] = useState(activeCard);
    if (activeCard && activeCard !== lastCard) setLastCard(activeCard);
    const selectedCard = activeCard || lastCard;
    const activeChubUrl = selectedCard ? getChubUrl(selectedCard) : null;
    const refreshMessage = refreshStatus && selectedCard && refreshStatus.cardId === selectedCard.id ? refreshStatus : null;

    return (
        <>
            {/* Main card modal */}
            <Transition.Root show={!!activeCard} as={Fragment} afterLeave={() => setLastCard(null)}>
                <Dialog as="div" className="fixed inset-x-0 bottom-0 top-[var(--archive-header-height)] z-50" onClose={closeCardDetails}>
                    <Transition.Child
                        as={Fragment}
                        enter="ease-out duration-200"
                        enterFrom="opacity-0"
                        enterTo="opacity-100"
                        leave="ease-in duration-150"
                        leaveFrom="opacity-100"
                        leaveTo="opacity-0"
                    >
                        <div className="fixed inset-x-0 bottom-0 top-[var(--archive-header-height)] bg-slate-950/70" />
                    </Transition.Child>

                    <div className="pointer-events-none fixed inset-x-0 bottom-0 top-[var(--archive-header-height)] overflow-hidden">
                        <div className="flex h-full justify-end">
                            <Transition.Child
                                as={Fragment}
                                enter="transform transition ease-out duration-300 motion-reduce:duration-0"
                                enterFrom="translate-x-full"
                                enterTo="translate-x-0"
                                leave="transform transition ease-in duration-300 motion-reduce:duration-0"
                                leaveFrom="translate-x-0"
                                leaveTo="translate-x-full"
                            >
                                <Dialog.Panel className="pointer-events-auto relative flex h-full w-full flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 sm:w-[95vw]">
                                    <button
                                        onClick={closeCardDetails}
                                        aria-label="Close card details"
                                        className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white/90 text-slate-700 backdrop-blur-sm hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-100 dark:hover:bg-slate-800"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>

                                    {selectedCard && (
                                        <div className="h-full overflow-y-auto overscroll-contain md:overflow-hidden">
                                            <div className="flex min-h-full flex-col md:h-full md:min-h-0 md:flex-row">
                                                <CardArtwork card={selectedCard} />

                                                <div className="min-w-0 flex-1 md:min-h-0">
                                                    <div className="px-4 py-5 md:h-full md:overflow-y-auto md:overscroll-contain md:px-6 md:py-6">
                                                        <div className="flex flex-col gap-3">
                                                            <div className="space-y-2">
                                                                <Dialog.Title className="pr-10 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 lg:text-3xl">
                                                                    {selectedCard.name}
                                                                </Dialog.Title>
                                                                <span className="text-sm text-slate-500 dark:text-slate-400">
                                                                    by{' '}
                                                                    {activeAuthorClickable ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => {
                                                                                handleAuthorClick(activeAuthor);
                                                                            }}
                                                                            className="font-semibold text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
                                                                        >
                                                                            {activeAuthorDisplay}
                                                                        </button>
                                                                    ) : (
                                                                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                                                                            {activeAuthorDisplay}
                                                                        </span>
                                                                    )}
                                                                </span>
                                                                {selectedCard.tagline && (
                                                                    <p className="rounded-lg bg-slate-100 px-2 py-1.5 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                                                        {selectedCard.tagline}
                                                                    </p>
                                                                )}
                                                                {selectedCard.vectorMatch?.text && (
                                                                    <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1.5 text-sm text-slate-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-slate-100">
                                                                        <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
                                                                            <Sparkles className="h-3 w-3" />
                                                                            Semantic match
                                                                            {selectedCard.vectorMatch.section && (
                                                                                <span className="text-slate-500 normal-case dark:text-slate-400">
                                                                                    {selectedCard.vectorMatch.section}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        <p className="text-sm leading-relaxed whitespace-pre-line">
                                                                            {selectedCard.vectorMatch.text}
                                                                        </p>
                                                                    </div>
                                                                )}
                                                                {(selectedCard.hasAlternateGreetings || selectedCard.hasLorebook || selectedCard.hasGallery || selectedCard.hasEmbeddedImages || selectedCard.hasExpressions) && (
                                                                    <div className="flex flex-wrap gap-2 text-xs">
                                                                        {selectedCard.hasAlternateGreetings && (
                                                                            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-100 px-2 py-1 font-medium text-indigo-600 dark:bg-indigo-500/30 dark:text-indigo-100">
                                                                                <Sparkles className="h-3 w-3" /> Alternate greetings available
                                                                            </span>
                                                                        )}
                                                                        {selectedCard.hasLorebook && (
                                                                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 font-medium text-emerald-600 dark:bg-emerald-500/30 dark:text-emerald-100">
                                                                                <BookOpen className="h-3 w-3" /> Embedded lorebook included
                                                                            </span>
                                                                        )}
                                                                        {selectedCard.hasGallery && (
                                                                            <span className="inline-flex items-center gap-1 rounded-md bg-teal-100 px-2 py-1 font-medium text-teal-600 dark:bg-teal-500/30 dark:text-teal-100">
                                                                                <Images className="h-3 w-3" /> Gallery included
                                                                            </span>
                                                                        )}
                                                                        {selectedCard.hasEmbeddedImages && (
                                                                            <span className="inline-flex items-center gap-1 rounded-md bg-orange-100 px-2 py-1 font-medium text-orange-600 dark:bg-orange-500/30 dark:text-orange-100">
                                                                                <ImageIcon className="h-3 w-3" /> Images embedded in text
                                                                            </span>
                                                                        )}
                                                                        {selectedCard.hasExpressions && (
                                                                            <span className="inline-flex items-center gap-1 rounded-md bg-purple-100 px-2 py-1 font-medium text-purple-600 dark:bg-purple-500/30 dark:text-purple-100">
                                                                                <Smile className="h-3 w-3" /> Expressions available
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {selectedCard.topics.length > 0 && (
                                                                    <div className="flex flex-wrap gap-2">
                                                                        {selectedCard.topics.map((tag) => (
                                                                            <button
                                                                                key={tag}
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    // handleTagClick already closes modal and navigates
                                                                                    handleTagClick(tag);
                                                                                }}
                                                                                className={clsx(
                                                                                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition',
                                                                                    highlightedTagsSet.has(tag.toLowerCase())
                                                                                        ? 'bg-indigo-600 text-white shadow-md'
                                                                                        : 'bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                                                                                )}
                                                                            >
                                                                                <Tag className="h-3 w-3" />
                                                                                {tag}
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {detailsLoading && (
                                                                <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-100/60 px-2 py-1.5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
                                                                    <Loader2 className="h-4 w-4 animate-spin" /> Loading card data...
                                                                </div>
                                                            )}

                                                            <CardDetailActions
                                                                card={selectedCard}
                                                                sourceUrl={activeChubUrl}
                                                                refreshing={refreshingCardId === selectedCard.id}
                                                                canPushToSilly={canPushToSilly}
                                                                canPushToArchitect={canPushToArchitect}
                                                                onFavorite={toggleFavoriteCard}
                                                                onRefresh={handleRefreshCard}
                                                                onDownload={handleDownload}
                                                                onPushToSilly={handlePushToSilly}
                                                                onPushToArchitect={handlePushToArchitect}
                                                                onCopyLink={handleCopyLink}
                                                            />

                                                            {/* Asset caching section - Hidden for now as manual caching is disabled/automatic
                                                            <div className="flex flex-wrap gap-2">
                                                                <button
                                                                    onClick={() => handleCacheAssets(selectedCard)}
                                                                    disabled={cachingAssets}
                                                                    className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                                >
                                                                    {cachingAssets ? (
                                                                        <>
                                                                            <Loader2 className="h-4 w-4 animate-spin" /> Caching assets...
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <Database className="h-4 w-4" />
                                                                            {assetCacheStatus?.cached
                                                                                ? `Cached (${assetCacheStatus.count})`
                                                                                : 'Cache assets'}
                                                                        </>
                                                                    )}
                                                                </button>
                                                                <button
                                                                    onClick={() => handleExportCard(selectedCard, false)}
                                                                    className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:text-slate-200"
                                                                >
                                                                    <FileDown className="h-4 w-4" /> Export original
                                                                </button>
                                                                {assetCacheStatus?.cached && (
                                                                    <button
                                                                        onClick={() => handleExportCard(selectedCard, true)}
                                                                        className="flex items-center justify-center gap-2 rounded-lg border border-emerald-200 px-2 py-1.5 text-sm font-medium text-emerald-600 shadow-sm transition hover:border-emerald-300 dark:border-emerald-600/40 dark:text-emerald-300"
                                                                    >
                                                                        <Archive className="h-4 w-4" /> Export with local assets
                                                                    </button>
                                                                )}
                                                            </div>
                                                            */}

                                                            {assetCacheMessage && (
                                                                <p
                                                                    className={clsx(
                                                                        'text-sm',
                                                                        assetCacheMessage.type === 'success'
                                                                            ? 'text-emerald-500 dark:text-emerald-300'
                                                                            : 'text-red-500 dark:text-red-400'
                                                                    )}
                                                                >
                                                                    {assetCacheMessage.message}
                                                                </p>
                                                            )}

                                                            {galleryMessage && (
                                                                <p
                                                                    className={clsx(
                                                                        'text-sm',
                                                                        galleryMessage.type === 'success'
                                                                            ? 'text-emerald-500 dark:text-emerald-300'
                                                                            : 'text-red-500 dark:text-red-400'
                                                                    )}
                                                                >
                                                                    {galleryMessage.message}
                                                                </p>
                                                            )}

                                                            {pushMessage && (
                                                                <p
                                                                    className={clsx(
                                                                        'text-sm',
                                                                        pushMessage.type === 'success'
                                                                            ? 'text-emerald-500 dark:text-emerald-300'
                                                                            : 'text-red-500 dark:text-red-400'
                                                                    )}
                                                                >
                                                                    {pushMessage.message}
                                                                </p>
                                                            )}

                                                            {refreshMessage && (
                                                                <p
                                                                    className={clsx(
                                                                        'text-sm',
                                                                        refreshMessage.type === 'success'
                                                                            ? 'text-emerald-500 dark:text-emerald-300'
                                                                            : 'text-red-500 dark:text-red-400'
                                                                    )}
                                                                >
                                                                    {refreshMessage.message}
                                                                </p>
                                                            )}

                                                            {tokenCounts && <TokenSummary counts={tokenCounts} formatKey={formatTokenKey} />}

                                                            {textSections.map((section) => (
                                                                <CollapsibleSection key={section.title} title={section.title}>
                                                                    <MarkdownContent content={section.value} />
                                                                </CollapsibleSection>
                                                            ))}

                                                            {alternateGreetings.length > 0 && (
                                                                <CollapsibleSection
                                                                    title={`Alternate Greetings (${alternateGreetings.length})`}
                                                                    renderContent={() => (
                                                                    <div className="space-y-3">
                                                                        {alternateGreetings.map((greeting: string, index: number) => (
                                                                            <NestedSection
                                                                                key={index}
                                                                                title={`Greeting ${index + 1}`}
                                                                                renderContent={() => (
                                                                                <MarkdownContent content={greeting} />
                                                                                )}
                                                                            />
                                                                        ))}
                                                                    </div>
                                                                    )}
                                                                />
                                                            )}

                                                            {(lorebookEntries.length > 0 || linkedLorebooks.length > 0) && (
                                                                <CollapsibleSection
                                                                    title="Lorebook"
                                                                    renderContent={() => (
                                                                    <div className="space-y-4">
                                                                        {lorebookEntries.length > 0 && (
                                                                            <div className="space-y-3">
                                                                                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                                                                    Embedded Lorebook ({lorebookEntries.length} entries)
                                                                                </h4>
                                                                                <div className="space-y-3">
                                                                                    {lorebookEntries.map((entry, index) => (
                                                                                        <NestedSection
                                                                                            key={`${entry.name ?? index}-${index}`}
                                                                                            title={entry.name || `Entry ${index + 1}`}
                                                                                            renderContent={() => (
                                                                                            <div className="space-y-3 text-sm">
                                                                                                {Array.isArray(entry.keys) &&
                                                                                                    entry.keys.length > 0 && (
                                                                                                        <div className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800/70 dark:text-slate-300">
                                                                                                            Keys: {entry.keys.join(', ')}
                                                                                                        </div>
                                                                                                    )}
                                                                                                {entry.content && (
                                                                                                    <MarkdownContent content={entry.content} />
                                                                                                )}
                                                                                                {entry.commentary && (
                                                                                                    <div className="rounded-xl border border-slate-200/70 bg-white/80 px-3 py-2 text-xs text-slate-500 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-300">
                                                                                                        Commentary:
                                                                                                        <div className="mt-2">
                                                                                                            <MarkdownContent
                                                                                                                content={entry.commentary}
                                                                                                            />
                                                                                                        </div>
                                                                                                    </div>
                                                                                                )}
                                                                                            </div>
                                                                                            )}
                                                                                        />
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                        {linkedLorebooks.length > 0 && (
                                                                            <div className="space-y-3">
                                                                                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                                                                    Linked Lorebook(s) ({linkedLorebooks.length})
                                                                                </h4>
                                                                                <div className="space-y-2">
                                                                                    {linkedLorebooks.map((lorebook, index) => (
                                                                                        <div
                                                                                            key={index}
                                                                                            className="rounded-xl border border-slate-200/70 bg-slate-50 px-2 py-1.5 text-sm dark:border-slate-700/70 dark:bg-slate-800/40"
                                                                                        >
                                                                                            <div className="font-semibold text-slate-700 dark:text-slate-200">
                                                                                                {lorebook.name || `Lorebook ${index + 1}`}
                                                                                            </div>
                                                                                            {lorebook.description && (
                                                                                                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                                                                                                    {lorebook.description}
                                                                                                </p>
                                                                                            )}
                                                                                            {lorebook.fullPath && (
                                                                                                <a
                                                                                                    href={`https://chub.ai/lorebooks/${lorebook.fullPath}`}
                                                                                                    target="_blank"
                                                                                                    rel="noreferrer"
                                                                                                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
                                                                                                >
                                                                                                    <Globe className="h-3 w-3" /> View on Chub
                                                                                                </a>
                                                                                            )}
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    )}
                                                                />
                                                            )}

                                                            {shouldShowGallerySection && selectedCard && (
                                                                <CollapsibleSection
                                                                    title={`Gallery (${galleryAssets.length})`}
                                                                    defaultOpen={galleryAssets.length > 0}
                                                                >
                                                                    {galleryLoading ? (
                                                                        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                                                                            <Loader2 className="h-4 w-4 animate-spin" /> Fetching gallery…
                                                                        </div>
                                                                    ) : galleryAssets.length > 0 ? (
                                                                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                                                            {galleryAssets.map((asset, index) => (
                                                                                <button
                                                                                    key={asset.id}
                                                                                    type="button"
                                                                                    onClick={() => openLightbox(index)}
                                                                                    className="group relative block overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm transition hover:border-indigo-300 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 dark:border-slate-700 dark:bg-slate-900/30"
                                                                                >
                                                                                    <div className="relative h-44 w-full overflow-hidden">
                                                                                        <Image
                                                                                            src={asset.thumbUrl || asset.url}
                                                                                            alt={
                                                                                                asset.title ||
                                                                                                selectedCard.name ||
                                                                                                'Gallery item'
                                                                                            }
                                                                                            fill
                                                                                            sizes="(min-width: 1024px) 200px, (min-width: 640px) 33vw, 50vw"
                                                                                            loading="lazy"
                                                                                            className="object-cover transition duration-200 group-hover:scale-[1.02]"
                                                                                        />
                                                                                    </div>
                                                                                    {(asset.title || asset.caption) && (
                                                                                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 text-xs font-medium text-white">
                                                                                            {asset.title || asset.caption}
                                                                                        </div>
                                                                                    )}
                                                                                </button>
                                                                            ))}
                                                                        </div>
                                                                    ) : (
                                                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                                                            {selectedCard.favorited
                                                                                ? 'No cached gallery images yet. Try toggling favorite or refreshing to pull them locally.'
                                                                                : 'This card has no cached gallery images. Favorite it to download the gallery locally.'}
                                                                        </p>
                                                                    )}
                                                                    {cardDetails.galleryError && (
                                                                        <p className="mt-3 text-sm text-red-500 dark:text-red-400">
                                                                            {cardDetails.galleryError}
                                                                        </p>
                                                                    )}
                                                                </CollapsibleSection>
                                                            )}

                                                            {cachedAssetsDetails.length > 0 && selectedCard && (
                                                                <CollapsibleSection
                                                                    title={`Cached Assets (${cachedAssetsDetails.length})`}
                                                                    defaultOpen={false}
                                                                    renderContent={() => cachedAssetsLoading ? (
                                                                        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                                                                            <Loader2 className="h-4 w-4 animate-spin" /> Loading cached
                                                                            assets…
                                                                        </div>
                                                                    ) : (
                                                                        <div className="space-y-2">
                                                                            {cachedAssetsDetails.map((asset) => {
                                                                                const metadata = asset.metadata
                                                                                    ? JSON.parse(asset.metadata)
                                                                                    : null;
                                                                                const fileSizeMB = asset.fileSize
                                                                                    ? (asset.fileSize / (1024 * 1024)).toFixed(2)
                                                                                    : 'N/A';
                                                                                const cachedDate = new Date(
                                                                                    asset.cachedAt
                                                                                ).toLocaleString();

                                                                                return (
                                                                                    <div
                                                                                        key={asset.id}
                                                                                        className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-xs dark:border-slate-700 dark:bg-slate-900/30"
                                                                                    >
                                                                                        <div className="mb-2 flex items-start justify-between gap-2">
                                                                                            <div className="flex items-center gap-2">
                                                                                                <Database className="h-4 w-4 flex-shrink-0 text-indigo-500" />
                                                                                                <span className="font-medium text-slate-700 dark:text-slate-300">
                                                                                                    {asset.assetType}
                                                                                                </span>
                                                                                            </div>
                                                                                            <span className="text-slate-500 dark:text-slate-400">
                                                                                                {fileSizeMB} MB
                                                                                            </span>
                                                                                        </div>

                                                                                        <div className="space-y-1 text-slate-600 dark:text-slate-400">
                                                                                            <div className="flex items-start gap-2">
                                                                                                <span className="font-medium text-slate-500 dark:text-slate-500">
                                                                                                    Path:
                                                                                                </span>
                                                                                                <code className="flex-1 break-all rounded bg-slate-900/10 px-1.5 py-0.5 font-mono text-[10px] dark:bg-slate-800/50">
                                                                                                    {asset.localPath}
                                                                                                </code>
                                                                                            </div>

                                                                                            <div className="flex items-start gap-2">
                                                                                                <span className="font-medium text-slate-500 dark:text-slate-500">
                                                                                                    URL:
                                                                                                </span>
                                                                                                <code className="flex-1 break-all rounded bg-slate-900/10 px-1.5 py-0.5 font-mono text-[10px] dark:bg-slate-800/50">
                                                                                                    {asset.originalUrl}
                                                                                                </code>
                                                                                            </div>

                                                                                            <div className="flex items-start gap-2">
                                                                                                <span className="font-medium text-slate-500 dark:text-slate-500">
                                                                                                    Cached:
                                                                                                </span>
                                                                                                <span className="text-[10px]">
                                                                                                    {cachedDate}
                                                                                                </span>
                                                                                            </div>

                                                                                            {metadata && (
                                                                                                <details className="mt-2">
                                                                                                    <summary className="cursor-pointer font-medium text-slate-500 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300">
                                                                                                        Metadata
                                                                                                    </summary>
                                                                                                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-900/10 p-2 font-mono text-[10px] dark:bg-slate-800/50">
                                                                                                        {JSON.stringify(metadata, null, 2)}
                                                                                                    </pre>
                                                                                                </details>
                                                                                            )}
                                                                                        </div>
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    )}
                                                                />
                                                            )}
                                                            <CollapsibleSection
                                                                title="Raw Metadata"
                                                                renderContent={() => detailsLoading ? (
                                                                    <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
                                                                        <Loader2 className="h-4 w-4 animate-spin" /> Loading metadata...
                                                                    </div>
                                                                ) : cardDetails.metadata ? (
                                                                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900/95 p-4 text-xs text-slate-100">
                                                                        {JSON.stringify(cardDetails.metadata, null, 2)}
                                                                    </pre>
                                                                ) : (
                                                                    <p className="text-sm text-slate-500 dark:text-slate-300">
                                                                        No metadata available.
                                                                    </p>
                                                                )}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </Dialog.Panel>
                            </Transition.Child>
                        </div>
                    </div>
                </Dialog>
            </Transition.Root>

            {/* Gallery lightbox */}
            <Transition.Root show={!!activeLightboxAsset} as={Fragment}>
                <Dialog
                    as="div"
                    className="fixed inset-0 z-[60]"
                    open={!!activeLightboxAsset}
                    onClose={closeLightbox}
                >
                    <Transition.Child
                        as={Fragment}
                        enter="ease-out duration-200"
                        enterFrom="opacity-0"
                        enterTo="opacity-100"
                        leave="ease-in duration-150"
                        leaveFrom="opacity-100"
                        leaveTo="opacity-0"
                    >
                        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm" />
                    </Transition.Child>

                    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 p-4 md:p-8">
                        <button
                            type="button"
                            onClick={closeLightbox}
                            className="absolute right-6 top-6 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-slate-800 shadow-lg transition hover:bg-white dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                            aria-label="Close gallery lightbox"
                        >
                            <X className="h-5 w-5" />
                        </button>

                        {activeLightboxAsset && (
                            <div className="relative flex w-full max-w-[98vw] flex-col gap-4 md:max-w-[95vw] xl:max-w-[90vw]">
                                <div className="relative flex items-center justify-between gap-4">
                                    <button
                                        type="button"
                                        onClick={showPrevAsset}
                                        className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-slate-800 shadow-lg transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                                        aria-label="Previous image"
                                    >
                                        <ArrowLeft className="h-5 w-5" />
                                    </button>
                                    <div className="relative h-[75vh] w-full overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl md:h-[82vh] xl:h-[85vh]">
                                        <Image
                                            src={activeLightboxAsset.url}
                                            alt={activeLightboxAsset.title || selectedCard?.name || 'Gallery item'}
                                            fill
                                            sizes="(max-width: 768px) 98vw, (max-width: 1280px) 95vw, 90vw"
                                            className="object-contain"
                                            priority
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={showNextAsset}
                                        className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-slate-800 shadow-lg transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                                        aria-label="Next image"
                                    >
                                        <ArrowRight className="h-5 w-5" />
                                    </button>
                                </div>
                                <div className="mx-auto w-full max-w-[98vw] rounded-2xl bg-black/40 px-6 py-4 text-center text-sm text-slate-100 backdrop-blur md:max-w-[95vw] xl:max-w-[90vw]">
                                    <div className="font-semibold text-white">
                                        {activeLightboxAsset.title || selectedCard?.name || 'Gallery item'}
                                    </div>
                                    {activeLightboxAsset.caption && (
                                        <p className="mt-2 text-slate-200">{activeLightboxAsset.caption}</p>
                                    )}
                                    <div className="mt-3 text-xs uppercase tracking-wide text-slate-300">
                                        {lightboxIndex !== null
                                            ? `Image ${lightboxIndex + 1} of ${galleryAssets.length}`
                                            : null}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </Dialog>
            </Transition.Root>
        </>
    );
};
