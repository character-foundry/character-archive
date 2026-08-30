'use client';

import { Fragment, type RefObject, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { X, Loader2, Save, Download, Settings, RefreshCw, Database, Search, User, Globe, FileJson } from 'lucide-react';
import clsx from 'clsx';
import type { Config, SyncRun } from '@/lib/types';

type MessageStatus = { type: 'success' | 'error'; message: string } | null;
type VectorGenerationStatus = {
    id: number;
    name: string;
    status: string;
    active: boolean;
    completed_items: number;
    total_items: number;
    dead_items: number;
    dimensions: number;
};
type VectorStatus = {
    runtime: { ready: boolean; model: string; dimensions: number; embeddingCircuit: { open: boolean; lastError?: string | null } };
    generations: VectorGenerationStatus[];
    queue: { durable: number; dead: number; legacy: number };
};

type SettingsModalProps = {
    showSettings: boolean;
    setShowSettings: (show: boolean) => void;
    config: Config | null;
    handleSaveConfig: (e: React.FormEvent<HTMLFormElement>) => void;
    configLoading: boolean;
    configSaveStatus: MessageStatus;
    chubProfileInputRef: RefObject<HTMLInputElement | null>;
    followedCreatorsTextareaRef: RefObject<HTMLTextAreaElement | null>;
    handleFetchChubFollows: () => void;
    isFetchingChubFollows: boolean;
    chubFollowStatus: MessageStatus;
    blockedCreatorsTextareaRef: RefObject<HTMLTextAreaElement | null>;
    handleFetchChubBlocked: () => void;
    isFetchingChubBlocked: boolean;
    chubBlockedStatus: MessageStatus;
    defaultSillyTavernState: {
        enabled: boolean;
        baseUrl: string;
        importEndpoint: string;
        csrfToken: string;
        sessionCookie: string;
        extraHeaders: Record<string, string>;
    };
    defaultCtSyncState: {
        enabled: boolean;
        intervalMinutes: number;
        pages: number;
        hitsPerPage: number;
        minTokens: number;
        maxTokens: number;
        bannedTags: string[];
        excludedWarnings: string[];
        bearerToken: string;
        cfClearance: string;
        session: string;
        allowedWarnings: string;
    };
    defaultVectorSearchState: {
        enabled: boolean;
        enableChunks: boolean;
        cardsIndex: string;
        chunksIndex: string;
        embedModel: string;
        embedderName: string;
        embedDimensions: number;
        embeddingProvider: string;
        embeddingUrl: string;
        embeddingApiKey: string;
        ollamaUrl: string;
        semanticRatio: number;
        cardsMultiplier: number;
        maxCardHits: number;
        chunkLimit: number;
        chunkWeight: number;
        rrfK: number;
    };
    defaultWyvernSyncState: {
        enabled: boolean;
        pageLimit: number;
        itemsPerPage: number;
        rating: string;
        bearerToken: string;
    };
    // Sync controls (passed from useSync)
    startChubSync: () => Promise<void>;
    chubSyncing: boolean;
    chubSyncStatus: string | null;
    startCtSync: () => Promise<void>;
    ctSyncing: boolean;
    ctSyncStatus: string | null;
    startWyvernSync: () => Promise<void>;
    wyvernSyncing: boolean;
    wyvernSyncStatus: string | null;
    startRisuSync: () => Promise<void>;
    risuSyncing: boolean;
    risuSyncStatus: string | null;
    anySyncing: boolean;
    latestSyncRun: SyncRun | null;
    cancelAllSyncs: () => void | Promise<void>;
};

type TabId = 'sync-control' | 'general' | 'silly' | 'ct' | 'chub' | 'vector' | 'risuai' | 'wyvern';

export const SettingsModal = ({
    showSettings,
    setShowSettings,
    config,
    handleSaveConfig,
    configLoading,
    configSaveStatus,
    chubProfileInputRef,
    followedCreatorsTextareaRef,
    handleFetchChubFollows,
    isFetchingChubFollows,
    chubFollowStatus,
    blockedCreatorsTextareaRef,
    handleFetchChubBlocked,
    isFetchingChubBlocked,
    chubBlockedStatus,
    defaultSillyTavernState,
    defaultCtSyncState,
    defaultVectorSearchState,
    defaultWyvernSyncState,
    startChubSync,
    chubSyncStatus,
    ctSyncing,
    ctSyncStatus,
    wyvernSyncing,
    wyvernSyncStatus,
    risuSyncing,
    risuSyncStatus,
    anySyncing,
    latestSyncRun,
    cancelAllSyncs,
}: SettingsModalProps) => {
    const [activeTab, setActiveTab] = useState<TabId>('sync-control');
    const [vectorStatus, setVectorStatus] = useState<VectorStatus | null>(null);
    const [vectorAction, setVectorAction] = useState<MessageStatus>(null);

    useEffect(() => {
        if (!showSettings || activeTab !== 'vector') return;
        let cancelled = false;
        const load = async () => {
            try {
                const response = await fetch('/api/vector/status', { cache: 'no-store' });
                if (!response.ok) throw new Error(`Vector status failed (${response.status})`);
                if (!cancelled) setVectorStatus(await response.json());
            } catch (error) {
                if (!cancelled) setVectorAction({ type: 'error', message: error instanceof Error ? error.message : 'Vector status failed' });
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [showSettings, activeTab]);

    const reconcileVectors = async () => {
        setVectorAction(null);
        try {
            const response = await fetch('/api/vector/reconcile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Vector reconcile failed');
            setVectorAction({ type: 'success', message: `Generation #${payload.id} is ${payload.status}.` });
            const statusResponse = await fetch('/api/vector/status', { cache: 'no-store' });
            if (statusResponse.ok) setVectorStatus(await statusResponse.json());
        } catch (error) {
            setVectorAction({ type: 'error', message: error instanceof Error ? error.message : 'Vector reconcile failed' });
        }
    };

    const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
        { id: 'sync-control', label: 'Sync Control', icon: <RefreshCw className="h-4 w-4" /> },
        { id: 'general', label: 'General', icon: <Settings className="h-4 w-4" /> },
        { id: 'silly', label: 'SillyTavern', icon: <Globe className="h-4 w-4" /> },
        { id: 'ct', label: 'Character Tavern', icon: <Database className="h-4 w-4" /> },
        { id: 'chub', label: 'Chub', icon: <User className="h-4 w-4" /> },
        { id: 'risuai', label: 'RisuAI', icon: <FileJson className="h-4 w-4" /> },
        { id: 'wyvern', label: 'Wyvern', icon: <Globe className="h-4 w-4" /> },
        { id: 'vector', label: 'Vector Search', icon: <Search className="h-4 w-4" /> },
    ];

    return (
        <Transition.Root show={showSettings} as={Fragment}>
            <Dialog onClose={() => setShowSettings(false)} className="relative z-50">
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />
                </Transition.Child>

                <div className="fixed inset-0 flex items-center justify-center p-4">
                    <Transition.Child
                        as={Fragment}
                        enter="ease-out duration-300"
                        enterFrom="opacity-0 scale-95"
                        enterTo="opacity-100 scale-100"
                        leave="ease-in duration-200"
                        leaveFrom="opacity-100 scale-100"
                        leaveTo="opacity-0 scale-95"
                    >
                        <Dialog.Panel className="relative flex max-h-[90vh] w-full max-w-[72rem] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
                            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
                                <Dialog.Title className="text-xl font-bold text-slate-900 dark:text-slate-100">
                                    Settings
                                </Dialog.Title>
                                <button
                                    onClick={() => setShowSettings(false)}
                                    className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>

                            {/* Tabs Header */}
                            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-6 py-2 scrollbar-hide dark:border-slate-800 dark:bg-slate-900/50">
                                {tabs.map((tab) => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={clsx(
                                            'flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                            activeTab === tab.id
                                                ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-indigo-400 dark:ring-slate-700'
                                                : 'text-slate-600 hover:bg-slate-200/50 dark:text-slate-400 dark:hover:bg-slate-800/50'
                                        )}
                                    >
                                        {tab.icon}
                                        {tab.label}
                                    </button>
                                ))}
                            </div>

                            <form
                                id="settings-form"
                                onSubmit={handleSaveConfig}
                                className="flex-1 overflow-y-auto px-6 py-6"
                            >
                                {/* Tab: Sync Control */}
                                <div className={clsx('space-y-6', activeTab !== 'sync-control' && 'hidden')}>
                                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                                        <div className="flex flex-wrap items-center justify-between gap-4">
                                            <div>
                                                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                                                    Manual Sync
                                                </h3>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    Runs all enabled sources together (Chub, Character Tavern, RisuAI, Wyvern).
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                                <button
                                                    type="button"
                                                    onClick={async () => startChubSync()}
                                                    disabled={anySyncing}
                                                    className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-indigo-500 disabled:bg-indigo-400"
                                                >
                                                    {anySyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                                    {anySyncing ? 'Syncing...' : 'Sync All'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => cancelAllSyncs()}
                                                    disabled={!anySyncing}
                                                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                                                >
                                                    <X className="h-4 w-4" />
                                                    Cancel All
                                                </button>
                                            </div>
                                        </div>
                                        <div className="mt-4 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                                            {chubSyncStatus && <p>{chubSyncStatus}</p>}
                                            {ctSyncStatus && <p>{ctSyncStatus}</p>}
                                            {risuSyncStatus && <p>{risuSyncStatus}</p>}
                                            {wyvernSyncStatus && <p>{wyvernSyncStatus}</p>}
                                            {!chubSyncStatus && !ctSyncStatus && !risuSyncStatus && !wyvernSyncStatus && (
                                                <p>No syncs running.</p>
                                            )}
                                        </div>
                                        {latestSyncRun && (
                                            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-700 dark:bg-slate-800/60">
                                                <div className="flex flex-wrap justify-between gap-2 font-medium text-slate-700 dark:text-slate-200">
                                                    <span>Run #{latestSyncRun.id} · {latestSyncRun.status}</span>
                                                    <span>{latestSyncRun.added} added · {latestSyncRun.updated} updated · {latestSyncRun.errors} errors</span>
                                                </div>
                                                {latestSyncRun.current_source && (
                                                    <p className="mt-2 text-indigo-600 dark:text-indigo-300">Current source: {latestSyncRun.current_source}</p>
                                                )}
                                                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                                                    {latestSyncRun.sources.map((source) => (
                                                        <p key={source.source} className={source.errors ? 'text-rose-600 dark:text-rose-300' : 'text-slate-500 dark:text-slate-400'}>
                                                            {source.source}: {source.status} · +{source.added} / ~{source.updated} / {source.errors} errors
                                                            {source.error_message ? ` · ${source.error_message}` : ''}
                                                        </p>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        {(ctSyncing || risuSyncing || wyvernSyncing) && (
                                            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                                                Individual source syncs are still available via API, but the UI runs them together.
                                            </p>
                                        )}
                                    </div>

                                    <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-6 dark:border-slate-800 dark:bg-slate-900/50">
                                        <h3 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-100">
                                            Integration Toggles
                                        </h3>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-indigo-700">
                                                <input
                                                    type="checkbox"
                                                    name="silly_enabled"
                                                    defaultChecked={config?.sillyTavern?.enabled || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Silly Tavern</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Push cards to ST</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-emerald-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-emerald-700">
                                                <input
                                                    type="checkbox"
                                                    name="ct_enabled"
                                                    defaultChecked={config?.ctSync?.enabled || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Character Tavern</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Sync from Character Tavern</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-indigo-700">
                                                <input
                                                    type="checkbox"
                                                    name="vector_enabled"
                                                    defaultChecked={config?.vectorSearch?.enabled ?? defaultVectorSearchState.enabled}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Vector Search</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Semantic & chunk search</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-indigo-700">
                                                <input
                                                    type="checkbox"
                                                    name="risu_enabled"
                                                    defaultChecked={config?.risuAiSync?.enabled || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">RisuAI</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Scrape realm.risuai.net</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-purple-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-purple-700">
                                                <input
                                                    type="checkbox"
                                                    name="wyvern_enabled"
                                                    defaultChecked={config?.wyvernSync?.enabled || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-purple-600 focus:ring-purple-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Wyvern</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Scrape wyvern.chat</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-indigo-700">
                                                <input
                                                    type="checkbox"
                                                    name="syncFollowedCreators"
                                                    defaultChecked={config?.syncFollowedCreators || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Chub Sync</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Sync followed creators</span>
                                                </div>
                                            </label>

                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-indigo-700">
                                                <input
                                                    type="checkbox"
                                                    name="autoUpdateMode"
                                                    defaultChecked={config?.autoUpdateMode || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-200">Auto-Update</span>
                                                    <span className="text-xs text-slate-500 dark:text-slate-400">Periodic background updates</span>
                                                </div>
                                            </label>
                                        </div>
                                    </div>
                                    
                                    <div className="prose prose-sm text-slate-500 dark:text-slate-400">
                                        <p>Enable or disable the main integration modules here. Configure their specific settings in the respective tabs.</p>
                                    </div>
                                </div>

                                {/* Tab: General */}
                                <div className={clsx('space-y-6', activeTab !== 'general' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            API Configuration
                                        </h3>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Meilisearch API Key</span>
                                            <input
                                                type="text"
                                                name="apikey"
                                                defaultValue={config?.apikey || ''}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Public Base URL</span>
                                            <input
                                                type="text"
                                                name="publicBaseUrl"
                                                defaultValue={config?.publicBaseUrl || ''}
                                                placeholder="http://localhost:6969"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                            <span className="text-xs text-slate-400 dark:text-slate-500">
                                                Used when building absolute URLs shared with external tools.
                                            </span>
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                Auto-Update Interval (seconds)
                                            </span>
                                            <input
                                                type="number"
                                                name="autoUpdateInterval"
                                                defaultValue={config?.autoUpdateInterval || 900}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                    </div>
                                </div>

                                {/* Tab: SillyTavern */}
                                <div className={clsx('space-y-6', activeTab !== 'silly' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Connection Details
                                        </h3>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Silly Tavern Base URL</span>
                                            <input
                                                type="text"
                                                name="silly_baseUrl"
                                                defaultValue={config?.sillyTavern?.baseUrl || ''}
                                                placeholder="http://purrsephone.local.vega.nyc:8100"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Import Endpoint</span>
                                            <input
                                                type="text"
                                                name="silly_importEndpoint"
                                                defaultValue={
                                                    config?.sillyTavern?.importEndpoint || defaultSillyTavernState.importEndpoint
                                                }
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">CSRF Token</span>
                                            <input
                                                type="text"
                                                name="silly_csrfToken"
                                                defaultValue={config?.sillyTavern?.csrfToken || ''}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Session Cookie</span>
                                            <input
                                                type="text"
                                                name="silly_sessionCookie"
                                                defaultValue={config?.sillyTavern?.sessionCookie || ''}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Extra Headers (JSON)</span>
                                            <textarea
                                                name="silly_extraHeaders"
                                                defaultValue={
                                                    config?.sillyTavern?.extraHeaders
                                                        ? JSON.stringify(config.sillyTavern.extraHeaders, null, 2)
                                                        : ''
                                                }
                                                rows={3}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>
                                    </div>
                                </div>

                                {/* Tab: Character Tavern */}
                                <div className={clsx('space-y-6', activeTab !== 'ct' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Sync Configuration
                                        </h3>
                                        <div className="grid gap-4 md:grid-cols-3">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Interval (minutes)</span>
                                                <input
                                                    type="number"
                                                    name="ct_intervalMinutes"
                                                    min="15"
                                                    defaultValue={config?.ctSync?.intervalMinutes ?? defaultCtSyncState.intervalMinutes}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Pages</span>
                                                <input
                                                    type="number"
                                                    name="ct_pages"
                                                    min="1"
                                                    defaultValue={config?.ctSync?.pages ?? defaultCtSyncState.pages}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Hits per page</span>
                                                <input
                                                    type="number"
                                                    name="ct_hitsPerPage"
                                                    min="1"
                                                    max="49"
                                                    defaultValue={config?.ctSync?.hitsPerPage ?? defaultCtSyncState.hitsPerPage}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Min tokens</span>
                                                <input
                                                    type="number"
                                                    name="ct_minTokens"
                                                    defaultValue={config?.ctSync?.minTokens ?? defaultCtSyncState.minTokens}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Max tokens</span>
                                                <input
                                                    type="number"
                                                    name="ct_maxTokens"
                                                    defaultValue={config?.ctSync?.maxTokens ?? defaultCtSyncState.maxTokens}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm md:col-span-3">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Bearer token</span>
                                                <input
                                                    type="text"
                                                    name="ct_bearerToken"
                                                    defaultValue={config?.ctSync?.bearerToken || ''}
                                                    placeholder="Paste CT search bearer token"
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                        </div>
                                        <div className="grid gap-3 md:grid-cols-3">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">cf_clearance cookie</span>
                                                <input
                                                    type="text"
                                                    name="ct_cfClearance"
                                                    defaultValue={config?.ctSync?.cfClearance || ''}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">session cookie</span>
                                                <input
                                                    type="text"
                                                    name="ct_session"
                                                    defaultValue={config?.ctSync?.session || ''}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">
                                                    Allowed warnings cookie
                                                </span>
                                                <input
                                                    type="text"
                                                    name="ct_allowedWarnings"
                                                    defaultValue={config?.ctSync?.allowedWarnings || ''}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                        </div>
                                        <div className="grid gap-3 md:grid-cols-2">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Banned tags</span>
                                                <textarea
                                                    name="ct_bannedTags"
                                                    rows={2}
                                                    defaultValue={(config?.ctSync?.bannedTags || defaultCtSyncState.bannedTags).join(
                                                        ', ',
                                                    )}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                                <span className="text-xs text-slate-400 dark:text-slate-500">
                                                    Cards containing any of these tags will be skipped.
                                                </span>
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Excluded warnings</span>
                                                <textarea
                                                    name="ct_excludedWarnings"
                                                    rows={2}
                                                    defaultValue={(
                                                        config?.ctSync?.excludedWarnings || defaultCtSyncState.excludedWarnings
                                                    ).join(', ')}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                                <span className="text-xs text-slate-400 dark:text-slate-500">
                                                    CT cards with these content warnings are ignored.
                                                </span>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                {/* Tab: Chub */}
                                <div className={clsx('space-y-6', activeTab !== 'chub' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Chub API Key
                                        </h3>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">API Key (samwise/CH-API-KEY)</span>
                                            <input
                                                type="text"
                                                name="chubApiKey"
                                                defaultValue={config?.chubApiKey || ''}
                                                placeholder="Your Chub.ai API key"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                            <span className="text-xs text-slate-400">Required for timeline mode, favorites sync, and fetching blocked users</span>
                                        </label>
                                    </div>

                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Chub Profile & Follows
                                        </h3>
                                        <div className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Chub Profile Name</span>
                                            <input
                                                ref={chubProfileInputRef}
                                                type="text"
                                                name="chubProfileName"
                                                defaultValue={config?.chubProfileName || ''}
                                                placeholder="e.g. honest_leg_4796"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                                <button
                                                    type="button"
                                                    onClick={handleFetchChubFollows}
                                                    disabled={isFetchingChubFollows}
                                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-600 transition hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-100"
                                                >
                                                    {isFetchingChubFollows ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Download className="h-4 w-4" />
                                                    )}
                                                    {isFetchingChubFollows ? 'Fetching...' : 'Load Followed Creators'}
                                                </button>
                                                {chubFollowStatus && (
                                                    <span
                                                        className={clsx(
                                                            'text-xs font-medium',
                                                            chubFollowStatus.type === 'success'
                                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                                : 'text-red-600 dark:text-red-400',
                                                        )}
                                                    >
                                                        {chubFollowStatus.message}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                Followed Creators (comma-separated)
                                            </span>
                                            <textarea
                                                ref={followedCreatorsTextareaRef}
                                                name="followedCreators"
                                                defaultValue={config?.followedCreators?.join(', ') || ''}
                                                rows={5}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>

                                        <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                            <input
                                                type="checkbox"
                                                name="followedCreatorsOnly"
                                                defaultChecked={config?.followedCreatorsOnly || false}
                                                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                            />
                                            Followed Creators Only (when syncing)
                                        </label>

                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-6">
                                            Blocked Creators
                                        </h3>
                                        <div className="flex flex-col gap-2 text-sm">
                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                                <button
                                                    type="button"
                                                    onClick={handleFetchChubBlocked}
                                                    disabled={isFetchingChubBlocked}
                                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-100 disabled:opacity-60 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
                                                >
                                                    {isFetchingChubBlocked ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Download className="h-4 w-4" />
                                                    )}
                                                    {isFetchingChubBlocked ? 'Fetching...' : 'Load Blocked Users'}
                                                </button>
                                                {chubBlockedStatus && (
                                                    <span
                                                        className={clsx(
                                                            'text-xs font-medium',
                                                            chubBlockedStatus.type === 'success'
                                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                                : 'text-red-600 dark:text-red-400',
                                                        )}
                                                    >
                                                        {chubBlockedStatus.message}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                Blocked Creators (comma-separated)
                                            </span>
                                            <textarea
                                                ref={blockedCreatorsTextareaRef}
                                                name="blockedCreators"
                                                defaultValue={config?.blockedCreators?.join(', ') || ''}
                                                rows={3}
                                                placeholder="Cards from these creators will be skipped during sync"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>

                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-6">
                                            Chub Scraper & Sync Settings
                                        </h3>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Min Tokens</span>
                                                <input
                                                    type="number"
                                                    name="min_tokens"
                                                    defaultValue={config?.min_tokens || 0}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Cards per Page</span>
                                                <input
                                                    type="number"
                                                    name="syncLimit"
                                                    defaultValue={config?.syncLimit || 20}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Page Limit</span>
                                                <input
                                                    type="number"
                                                    name="pageLimit"
                                                    defaultValue={config?.pageLimit || 10}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Start Page</span>
                                                <input
                                                    type="number"
                                                    name="startPage"
                                                    defaultValue={config?.startPage || 1}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                        </div>

                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                Include Tags (comma-separated)
                                            </span>
                                            <textarea
                                                name="topic"
                                                defaultValue={config?.topic || ''}
                                                rows={2}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>

                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                                Exclude Tags (comma-separated)
                                            </span>
                                            <textarea
                                                name="excludeTopic"
                                                defaultValue={config?.excludeTopic || ''}
                                                rows={2}
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                        </label>

                                        <div className="grid gap-3 sm:grid-cols-2">
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    name="cycle_topics"
                                                    defaultChecked={config?.cycle_topics || false}
                                                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                Cycle Topics
                                            </label>
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    name="syncTagsMode"
                                                    defaultChecked={config?.syncTagsMode || false}
                                                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                Sync Tags Mode
                                            </label>
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    name="backupMode"
                                                    defaultChecked={config?.backupMode || false}
                                                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                Backup Mode
                                            </label>
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    name="use_timeline"
                                                    defaultChecked={config?.use_timeline || false}
                                                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                Use Timeline
                                            </label>
                                            <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-inner transition hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    name="syncByNew"
                                                    defaultChecked={config?.syncByNew || false}
                                                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                Sync By New (Created Date)
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                {/* Tab: RisuAI */}
                                <div className={clsx('space-y-6', activeTab !== 'risuai' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            RisuAI Configuration
                                        </h3>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Page Limit</span>
                                                <input
                                                    type="number"
                                                    name="risu_pageLimit"
                                                    min="1"
                                                    defaultValue={config?.risuAiSync?.pageLimit || 5}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex items-center gap-3 text-sm">
                                                <input
                                                    type="checkbox"
                                                    name="risu_forceUpdate"
                                                    defaultChecked={config?.risuAiSync?.forceUpdate || false}
                                                    className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                                                />
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-slate-700 dark:text-slate-300">Force Update</span>
                                                    <span className="text-xs text-slate-400 dark:text-slate-500">Re-download existing cards</span>
                                                </div>
                                            </label>
                                        </div>
                                        <p className="text-xs text-slate-400 dark:text-slate-500">
                                            Scrapes the latest cards from realm.risuai.net. Downloads V3 JSON, CharX, or embedded PNGs depending on availability.
                                            By default, existing cards are skipped (RisuAI dates are unreliable). Enable Force Update to re-download all cards.
                                        </p>
                                    </div>
                                </div>

                                {/* Tab: Wyvern */}
                                <div className={clsx('space-y-6', activeTab !== 'wyvern' && 'hidden')}>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Wyvern Configuration
                                        </h3>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Page Limit</span>
                                                <input
                                                    type="number"
                                                    name="wyvern_pageLimit"
                                                    min="1"
                                                    defaultValue={config?.wyvernSync?.pageLimit ?? defaultWyvernSyncState.pageLimit}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Items per Page</span>
                                                <input
                                                    type="number"
                                                    name="wyvern_itemsPerPage"
                                                    min="1"
                                                    max="100"
                                                    defaultValue={config?.wyvernSync?.itemsPerPage ?? defaultWyvernSyncState.itemsPerPage}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Rating Filter</span>
                                                <select
                                                    name="wyvern_rating"
                                                    defaultValue={config?.wyvernSync?.rating ?? defaultWyvernSyncState.rating}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                >
                                                    <option value="none">SFW Only</option>
                                                    <option value="suggestive">SFW + Suggestive</option>
                                                    <option value="explicit">All (including NSFW)</option>
                                                </select>
                                            </label>
                                        </div>
                                        <label className="flex flex-col gap-2 text-sm">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">Bearer Token (Firebase JWT)</span>
                                            <textarea
                                                name="wyvern_bearerToken"
                                                rows={3}
                                                defaultValue={config?.wyvernSync?.bearerToken || ''}
                                                placeholder="Paste JWT from browser (expires hourly)"
                                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                            />
                                            <span className="text-xs text-slate-400 dark:text-slate-500">
                                                Get from browser DevTools &gt; Network tab &gt; Authorization header. Token expires hourly.
                                            </span>
                                        </label>
                                        <p className="text-xs text-slate-400 dark:text-slate-500">
                                            Scrapes characters from wyvern.chat API. Uses explore search endpoint and downloads full character data with avatar images.
                                        </p>
                                    </div>
                                </div>

                                {/* Tab: Vector Search */}
                                <div className={clsx('space-y-6', activeTab !== 'vector' && 'hidden')}>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-700 dark:bg-slate-800/60">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="text-slate-600 dark:text-slate-300">
                                                <p className="font-semibold">Durable vector generations</p>
                                                <p className="mt-1">
                                                    {vectorStatus
                                                        ? `${vectorStatus.queue.durable.toLocaleString()} queued · ${vectorStatus.queue.dead} dead · query ${vectorStatus.runtime.ready ? 'ready' : 'not ready'}`
                                                        : 'Loading vector status…'}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={reconcileVectors}
                                                className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500"
                                            >
                                                <RefreshCw className="h-4 w-4" /> Reconcile shadow index
                                            </button>
                                        </div>
                                        {vectorStatus?.runtime.embeddingCircuit.open && (
                                            <p className="mt-2 text-rose-600 dark:text-rose-300">Embedding circuit open: {vectorStatus.runtime.embeddingCircuit.lastError}</p>
                                        )}
                                        <div className="mt-3 space-y-1">
                                            {vectorStatus?.generations.slice(0, 4).map(generation => (
                                                <p key={generation.id} className="text-slate-500 dark:text-slate-400">
                                                    #{generation.id} {generation.active ? 'active' : generation.status} · {generation.dimensions}d · {generation.completed_items.toLocaleString()}/{generation.total_items.toLocaleString()} · {generation.dead_items} dead
                                                </p>
                                            ))}
                                        </div>
                                        {vectorAction && (
                                            <p className={clsx('mt-2', vectorAction.type === 'error' ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300')}>
                                                {vectorAction.message}
                                            </p>
                                        )}
                                    </div>
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Meilisearch + Embeddings
                                        </h3>
                                        <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                            <input
                                                type="checkbox"
                                                name="vector_enableChunks"
                                                defaultChecked={config?.vectorSearch?.enableChunks ?? defaultVectorSearchState.enableChunks}
                                                className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                                            />
                                            <span className="space-y-1">
                                                <span className="block font-medium">Enable chunk vectors</span>
                                                <span className="block text-xs text-slate-500 dark:text-slate-400">
                                                    Keep this on if you want semantic snippets and chunk-level reranking. Turn it off to use only the whole-card vector index and skip building <code>card_chunks</code>.
                                                </span>
                                            </span>
                                        </label>
                                        <div className="grid gap-4 md:grid-cols-2">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Cards index UID</span>
                                                <input
                                                    type="text"
                                                    name="vector_cardsIndex"
                                                    defaultValue={config?.vectorSearch?.cardsIndex ?? defaultVectorSearchState.cardsIndex}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Chunk index UID</span>
                                                <input
                                                    type="text"
                                                    name="vector_chunksIndex"
                                                    defaultValue={config?.vectorSearch?.chunksIndex ?? defaultVectorSearchState.chunksIndex}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Embed model</span>
                                                <input
                                                    type="text"
                                                    name="vector_embedModel"
                                                    defaultValue={config?.vectorSearch?.embedModel ?? defaultVectorSearchState.embedModel}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Meili embedder name</span>
                                                <input
                                                    type="text"
                                                    name="vector_embedderName"
                                                    defaultValue={config?.vectorSearch?.embedderName ?? defaultVectorSearchState.embedderName}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm md:col-span-2">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Embedding provider</span>
                                                <select
                                                    name="vector_embeddingProvider"
                                                    defaultValue={config?.vectorSearch?.embeddingProvider ?? defaultVectorSearchState.embeddingProvider}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                >
                                                    <option value="ollama">Ollama</option>
                                                    <option value="openai">OpenAI-compatible</option>
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm md:col-span-2">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Embedding URL</span>
                                                <input
                                                    type="text"
                                                    name="vector_embeddingUrl"
                                                    defaultValue={config?.vectorSearch?.embeddingUrl || config?.vectorSearch?.ollamaUrl || defaultVectorSearchState.ollamaUrl}
                                                    placeholder="http://127.0.0.1:11434 or https://inference.example.com"
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm md:col-span-2">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Embedding API key</span>
                                                <input
                                                    type="password"
                                                    name="vector_embeddingApiKey"
                                                    defaultValue={config?.vectorSearch?.embeddingApiKey ?? defaultVectorSearchState.embeddingApiKey}
                                                    autoComplete="off"
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                        </div>
                                        <div className="grid gap-4 md:grid-cols-3">
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Semantic ratio</span>
                                                <input
                                                    type="number"
                                                    name="vector_semanticRatio"
                                                    min="0"
                                                    max="1"
                                                    step="0.1"
                                                    defaultValue={config?.vectorSearch?.semanticRatio ?? defaultVectorSearchState.semanticRatio}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Cards multiplier</span>
                                                <input
                                                    type="number"
                                                    name="vector_cardsMultiplier"
                                                    min="1"
                                                    step="0.5"
                                                    defaultValue={config?.vectorSearch?.cardsMultiplier ?? defaultVectorSearchState.cardsMultiplier}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Max card hits</span>
                                                <input
                                                    type="number"
                                                    name="vector_maxCardHits"
                                                    min="50"
                                                    defaultValue={config?.vectorSearch?.maxCardHits ?? defaultVectorSearchState.maxCardHits}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Chunk limit</span>
                                                <input
                                                    type="number"
                                                    name="vector_chunkLimit"
                                                    min="20"
                                                    defaultValue={config?.vectorSearch?.chunkLimit ?? defaultVectorSearchState.chunkLimit}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">Chunk weight</span>
                                                <input
                                                    type="number"
                                                    name="vector_chunkWeight"
                                                    min="0"
                                                    step="0.1"
                                                    defaultValue={config?.vectorSearch?.chunkWeight ?? defaultVectorSearchState.chunkWeight}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-2 text-sm">
                                                <span className="font-medium text-slate-700 dark:text-slate-300">RRF k</span>
                                                <input
                                                    type="number"
                                                    name="vector_rrfK"
                                                    min="1"
                                                    defaultValue={config?.vectorSearch?.rrfK ?? defaultVectorSearchState.rrfK}
                                                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                                />
                                            </label>
                                        </div>
                                        <details className="rounded-2xl border border-slate-200 bg-white/70 p-4 text-xs text-slate-600 transition dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                            <summary className="cursor-pointer font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">
                                                How the knobs affect results
                                            </summary>
                                            <div className="mt-3 space-y-2 leading-relaxed">
                                                <p>
                                                    <strong>Vector search</strong> needs the cards index populated. Chunk vectors are optional: keep <code>Enable chunk vectors</code> on only if you also want the <code>card_chunks</code> index and semantic snippets.
                                                </p>
                                                <p>
                                                    <strong>Embedding URL &amp; model</strong> must match whatever powered the backfill. Changing the model requires regenerating embeddings or results will be meaningless.
                                                </p>
                                                <p>
                                                    <strong>Cards / chunk indexes</strong> tell the API which Meili UID to query. When chunk vectors are disabled, the chunk UID is ignored and can stay reserved for later.
                                                </p>
                                                <p>
                                                    <strong>Semantic ratio</strong> biases Meili between lexical and vector scoring. Values around 0.3‑0.5 keep keyword intent intact; go lower for proper nouns, higher for vibes.
                                                </p>
                                                <p>
                                                    <strong>Cards multiplier</strong> controls how many lexical hits we fetch before fusing with chunk hits. If exact matches disappear, bump this toward 3‑4 so the baseline list stays deep enough.
                                                </p>
                                                <p>
                                                    <strong>Chunk limit / weight</strong> only apply when chunk vectors are enabled. Lower the weight if semantic snippets drown out obvious keyword matches; raise it when you want long-form alternates to drive the ranking.
                                                </p>
                                                <p>
                                                    <strong>RRF k</strong> is the denominator inside reciprocal-rank fusion. Higher values flatten the advantage of top-ranked items; leave it at 60 unless you have a reason to rebalance the curve.
                                                </p>
                                            </div>
                                        </details>
                                    </div>
                                </div>
                            </form>

                            <div className="flex shrink-0 flex-col gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-800">
                                {configSaveStatus && (
                                    <div
                                        className={clsx(
                                            'rounded-2xl border px-4 py-3 text-sm transition-opacity duration-300',
                                            configSaveStatus.type === 'success'
                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100'
                                                : 'border-red-200 bg-red-50 text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100',
                                        )}
                                    >
                                        {configSaveStatus.message}
                                    </div>
                                )}
                                <div className="flex items-center justify-end gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setShowSettings(false)}
                                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        form="settings-form"
                                        disabled={configLoading}
                                        className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:bg-indigo-500 disabled:bg-indigo-400"
                                    >
                                        {configLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                        Save Settings
                                    </button>
                                </div>
                            </div>
                        </Dialog.Panel>
                    </Transition.Child>
                </div>
            </Dialog>
        </Transition.Root>
    );
};
