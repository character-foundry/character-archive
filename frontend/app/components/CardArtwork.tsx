import Image from 'next/image';
import { Globe, Hash, Heart } from 'lucide-react';
import type { Card } from '@/lib/types';

export function CardArtwork({ card }: { card: Card }) {
  const source =
    card.source === 'ct'
      ? 'Character Tavern'
      : card.source === 'risuai'
        ? 'RisuAI'
        : card.source === 'wyvern'
          ? 'Wyvern'
          : 'Chub';
  return (
    <aside
      className="relative isolate flex min-h-[360px] shrink-0 flex-col justify-end overflow-hidden bg-slate-950 text-slate-200 md:h-full md:min-h-0 md:w-[35%]"
      aria-label="Character artwork and source"
    >
      <Image
        src={card.imagePath}
        alt={card.name}
        fill
        sizes="(max-width: 767px) 100vw, 32vw"
        className="-z-20 object-cover object-[center_35%] md:object-top"
      />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-1/3 bg-gradient-to-r from-transparent to-slate-950 md:block" />
      <div className="space-y-4 bg-gradient-to-t from-slate-950 via-slate-950/85 to-transparent px-5 pb-5 pt-20 md:px-6 md:pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium">
          <span className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5 text-indigo-300" />
            {(card.tokenCount || 0).toLocaleString()} tokens
          </span>
          <span className="flex items-center gap-1.5">
            <Heart className="h-3.5 w-3.5 text-rose-300" />
            {(card.n_favorites || 0).toLocaleString()}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/15 pt-3 text-xs">
          {[
            ['Last updated', card.lastModified],
            ['Created', card.createdAt],
            ['Language', card.language],
            ['Visibility', card.visibility],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {label}
              </dt>
              <dd className="mt-0.5 break-words">{value || '—'}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-slate-300">{source}</span>
          {card.sourceUrl && (
            <a
              href={card.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
            >
              <Globe className="h-3 w-3" />
              View source
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
