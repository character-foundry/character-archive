import { ArrowLeft, ArrowRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import clsx from "clsx";

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  size?: "sm" | "md";
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLast: () => void;
}

export function PaginationControls({
  page,
  totalPages,
  size = "md",
  onFirst,
  onPrev,
  onNext,
  onLast,
}: PaginationControlsProps) {
  const btnClass = clsx(
    "flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
    size === "md" ? "h-9 w-9" : "h-8 w-8"
  );

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onFirst}
        disabled={page === 1}
        className={btnClass}
        aria-label="Go to first page"
        title="First page"
      >
        <ChevronsLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 1}
        className={btnClass}
        aria-label="Previous page"
        title="Previous page"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        className={btnClass}
        aria-label="Next page"
        title="Next page"
      >
        <ArrowRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onLast}
        disabled={page >= totalPages}
        className={btnClass}
        aria-label="Go to last page"
        title="Last page"
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
    </div>
  );
}
