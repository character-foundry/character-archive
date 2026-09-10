import { useEffect, useRef } from "react";
import {
  BarChart3,
  BookmarkPlus,
  Database,
  Loader2,
  Moon,
  Network,
  RefreshCw,
  Settings,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { PaginationControls } from "./PaginationControls";

interface PaginationHeaderProps {
  page: number;
  totalPages: number;
  pageLabel: string;
  isLoading: boolean;
  syncing: boolean;
  darkMode: boolean;
  onGoToFirstPage: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onGoToLastPage: () => void;
  onRefresh: () => void;
  onSaveSearch: () => void;
  onSync: () => void;
  onOpenFederation: () => void;
  onOpenSettings: () => void;
  onToggleDarkMode: () => void;
}

export function PaginationHeader({
  page,
  totalPages,
  pageLabel,
  isLoading,
  syncing,
  darkMode,
  onGoToFirstPage,
  onNavigateBack,
  onNavigateForward,
  onGoToLastPage,
  onRefresh,
  onSaveSearch,
  onSync,
  onOpenFederation,
  onOpenSettings,
  onToggleDarkMode,
}: PaginationHeaderProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const updateHeight = () => document.documentElement.style.setProperty('--archive-header-height', `${header.getBoundingClientRect().height}px`);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={headerRef} data-archive-header className="sticky top-0 z-40 border-b border-slate-200 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-2 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-6 sm:py-3 md:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto_auto_auto_auto]">
        <PaginationControls
          page={page}
          totalPages={totalPages}
          size="md"
          onFirst={onGoToFirstPage}
          onPrev={onNavigateBack}
          onNext={onNavigateForward}
          onLast={onGoToLastPage}
        />
        <div className="min-w-0 text-center md:col-start-4 md:row-start-1">
          <div className="md:absolute md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2">
            <h1 className="truncate text-sm font-bold leading-5 tracking-tight text-slate-900 md:text-base dark:text-slate-100">Character Archive</h1>
            <p className="truncate text-[10px] font-medium leading-4 text-slate-500 md:text-[11px] dark:text-slate-400" title={pageLabel}>{pageLabel}</p>
          </div>
        </div>
        <div className="col-span-2 flex items-center justify-end gap-1.5 sm:col-span-1 md:contents">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="md:col-start-2 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            aria-label="Refresh list"
            title="Refresh list"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onSaveSearch}
            className="md:col-start-3 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            aria-label="Save search"
            title="Save search"
          >
            <BookmarkPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onSync}
            disabled={syncing}
            className="md:col-start-5 md:row-start-1 flex h-8 w-8 items-center justify-center gap-2 md:h-9 md:w-9 lg:w-auto rounded-md bg-purple-600 px-2 md:px-2.5 py-1.5 text-sm font-semibold text-white shadow-lg transition hover:bg-purple-500 disabled:bg-purple-400"
            aria-label="Sync all enabled sources"
            title="Sync all enabled sources"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            <span className="hidden lg:inline">{syncing ? "Syncing..." : "Sync All"}</span>
          </button>
          <button
            type="button"
            onClick={onOpenFederation}
            className="md:col-start-6 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Federation"
            title="Federation settings"
          >
            <Network className="h-4 w-4" />
          </button>
          <Link
            href="/metrics"
            className="md:col-start-7 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Metrics"
            title="Archive Metrics"
          >
            <BarChart3 className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={onOpenSettings}
            className="md:col-start-8 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Settings"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleDarkMode}
            className="md:col-start-9 md:row-start-1 flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            title={darkMode ? "Light mode" : "Dark mode"}
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
