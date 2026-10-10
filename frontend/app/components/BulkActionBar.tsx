import { Loader2, RefreshCw, Trash2 } from "lucide-react";

interface BulkActionBarProps {
  selectedCount: number;
  bulkRefreshing: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkRefresh: () => void;
  onBulkDelete: () => void;
}

export function BulkActionBar({
  selectedCount,
  bulkRefreshing,
  onSelectAll,
  onClearSelection,
  onBulkRefresh,
  onBulkDelete,
}: BulkActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">All cards</h2>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-300 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          disabled={selectedCount === 0}
          className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:border-slate-300 hover:text-slate-800 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onBulkRefresh}
          disabled={selectedCount === 0 || bulkRefreshing}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          {bulkRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Update selected from source
        </button>
        <button
          type="button"
          onClick={onBulkDelete}
          disabled={selectedCount === 0}
          className="inline-flex items-center gap-2 rounded-full bg-red-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow-sm transition hover:bg-red-400 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete selected
        </button>
      </div>
    </div>
  );
}
