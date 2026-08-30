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
  return (
    <div className="sticky top-0 z-40 border-b border-slate-200 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-6 py-4">
        <PaginationControls
          page={page}
          totalPages={totalPages}
          size="md"
          onFirst={onGoToFirstPage}
          onPrev={onNavigateBack}
          onNext={onNavigateForward}
          onLast={onGoToLastPage}
        />
        <div className="flex flex-1 items-center justify-center text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>{pageLabel}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            aria-label="Refresh list"
            title="Refresh list"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onSaveSearch}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            aria-label="Save search"
            title="Save search"
          >
            <BookmarkPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-2 rounded-full bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:bg-purple-500 disabled:bg-purple-400"
            aria-label="Sync all enabled sources"
            title="Sync all enabled sources"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            {syncing ? "Syncing..." : "Sync All"}
          </button>
          <button
            type="button"
            onClick={onOpenFederation}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Federation"
            title="Federation settings"
          >
            <Network className="h-4 w-4" />
          </button>
          <Link
            href="/metrics"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Metrics"
            title="Archive Metrics"
          >
            <BarChart3 className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Settings"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleDarkMode}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
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
