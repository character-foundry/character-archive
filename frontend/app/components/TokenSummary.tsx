interface TokenSummaryProps {
  counts: Record<string, number | string | null | undefined>;
  formatKey: (key: string) => string;
}

export function TokenSummary({ counts, formatKey }: TokenSummaryProps) {
  return (
    <dl
      aria-label="Token counts"
      className="grid grid-cols-3 gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40"
    >
      {Object.entries(counts).map(([key, value]) => (
        <div key={key} className="flex min-w-0 items-baseline justify-between gap-2 py-0.5">
          <dt
            title={formatKey(key)}
            className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
          >
            {formatKey(key)}
          </dt>
          <dd className="shrink-0 text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {typeof value === 'number' ? value.toLocaleString() : (value ?? '—')}
          </dd>
        </div>
      ))}
    </dl>
  );
}
