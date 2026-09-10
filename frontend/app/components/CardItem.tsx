import Image from 'next/image';
import clsx from 'clsx';
import {
  BookOpen,
  Check,
  Hash,
  Heart,
  Image as ImageIcon,
  Images,
  PenTool,
  PlugZap,
  Smile,
  Sparkles,
  Star,
} from 'lucide-react';
import type { Card } from '@/lib/types';
import { CardItemActions } from './CardItemActions';

interface CardItemProps {
  card: Card;
  index: number;
  isSelected: boolean;
  highlightedTagsSet: Set<string>;
  canPushToSilly: boolean;
  chubUrl: string | null;
  onOpenDetails: (card: Card) => void;
  onCardTextClick: (event: React.MouseEvent<HTMLElement>, card: Card, index: number) => void;
  onTagClick: (tag: string) => void;
  onAuthorClick: (author: string) => void;
  onToggleFavorite: (card: Card) => void;
  onDownload: (card: Card) => void;
  onPushToSilly: (card: Card) => void;
  onCopyLink: (card: Card) => void;
  onDelete: (card: Card) => void;
}

export function CardItem({
  card,
  index,
  isSelected,
  highlightedTagsSet,
  canPushToSilly,
  chubUrl,
  onOpenDetails,
  onCardTextClick,
  onTagClick,
  onAuthorClick,
  onToggleFavorite,
  onDownload,
  onPushToSilly,
  onCopyLink,
  onDelete,
}: CardItemProps) {
  const author = card.author?.trim();
  const source =
    card.source === 'ct'
      ? 'CT'
      : card.source === 'risuai'
        ? 'Risu'
        : card.source === 'wyvern'
          ? 'Wyvern'
          : 'Chub';
  const features = [
    { enabled: card.hasAlternateGreetings, icon: Sparkles, label: 'Alternate greetings' },
    { enabled: card.hasLorebook, icon: BookOpen, label: 'Lorebook' },
    { enabled: card.hasGallery, icon: Images, label: 'Gallery' },
    { enabled: card.hasEmbeddedImages, icon: ImageIcon, label: 'Embedded images' },
    { enabled: card.hasExpressions, icon: Smile, label: 'Expressions' },
  ].filter((feature) => feature.enabled);

  return (
    <div
      data-card-id={card.id}
      className={clsx(
        'group relative isolate aspect-[9/16] min-w-0 cursor-pointer overflow-hidden rounded-xl border bg-slate-950 text-white shadow-sm transition duration-200 hover:border-slate-500 hover:shadow-lg motion-reduce:transition-none',
        isSelected
          ? 'border-indigo-400 ring-2 ring-indigo-400/70'
          : 'border-slate-300/40 dark:border-slate-700/70',
      )}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) onCardTextClick(event, card, index);
        else onOpenDetails(card);
      }}
    >
      <Image
        src={card.imagePath}
        alt=""
        fill
        sizes="(max-width: 639px) 50vw, (max-width: 900px) 33vw, (max-width: 1100px) 25vw, 240px"
        loading="lazy"
        className="object-cover object-top transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/35 to-transparent" />
      <button
        type="button"
        aria-label={`Open ${card.name}`}
        className="absolute inset-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-indigo-300"
      />

      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
        <button
          type="button"
          aria-label={`${isSelected ? 'Deselect' : 'Select'} ${card.name}`}
          aria-pressed={isSelected}
          onClick={(event) => {
            event.stopPropagation();
            onCardTextClick(event, card, index);
          }}
          className={clsx(
            'pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md border backdrop-blur-sm transition',
            isSelected
              ? 'border-indigo-300 bg-indigo-600'
              : 'border-white/30 bg-slate-950/45 hover:bg-slate-950/70',
          )}
        >
          {isSelected ? (
            <Check className="h-4 w-4" />
          ) : (
            <span className="h-3.5 w-3.5 rounded-sm border border-white/80" />
          )}
        </button>
        <div className="flex flex-wrap justify-end gap-1 text-[10px] font-semibold">
          <span
            className={clsx(
              'rounded px-1.5 py-1 backdrop-blur-sm',
              card.source === 'ct'
                ? 'bg-emerald-950/85 text-emerald-200'
                : card.source === 'risuai'
                  ? 'bg-pink-950/85 text-pink-200'
                  : card.source === 'wyvern'
                    ? 'bg-purple-950/85 text-purple-200'
                    : 'bg-slate-950/75 text-slate-200',
            )}
          >
            {source}
          </span>
          <span
            title={`${card.tokenCount || 0} tokens`}
            className="flex items-center gap-0.5 rounded bg-slate-950/75 px-1.5 py-1 text-slate-200"
          >
            <Hash className="h-3 w-3" />
            {Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
              card.tokenCount || 0,
            )}
          </span>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1 text-white/85">
          {features.map(({ icon: Icon, label }) => (
            <span
              key={label}
              title={label}
              aria-label={label}
              className="rounded bg-slate-950/65 p-1"
            >
              <Icon className="h-3 w-3" />
            </span>
          ))}
          {card.loadedInSillyTavern && (
            <span
              title="Loaded in SillyTavern"
              className="flex items-center gap-1 rounded bg-emerald-950/85 px-1.5 py-1 text-[10px] text-emerald-200"
            >
              <PlugZap className="h-3 w-3" />
              ST
            </span>
          )}
          {card.syncedToArchitect && (
            <span
              title="Synced to Character Architect"
              className="flex items-center gap-1 rounded bg-violet-950/85 px-1.5 py-1 text-[10px] text-violet-200"
            >
              <PenTool className="h-3 w-3" />
              CA
            </span>
          )}
        </div>
        <div>
          <h2 className="line-clamp-2 text-base font-bold leading-tight tracking-tight text-white sm:text-lg">
            {card.name}
          </h2>
          <button
            type="button"
            disabled={!author}
            onClick={(event) => {
              event.stopPropagation();
              if (author) onAuthorClick(author);
            }}
            className="pointer-events-auto mt-1 block max-w-full truncate text-xs text-slate-300 underline-offset-2 enabled:hover:text-white enabled:hover:underline"
          >
            by {author || 'Unknown'}
          </button>
          {card.tagline && (
            <p className="mt-1 hidden text-xs leading-relaxed text-slate-300 sm:line-clamp-2">
              {card.tagline}
            </p>
          )}
        </div>
        {card.topics.length > 0 && (
          <div className="flex max-h-5 gap-1 overflow-hidden">
            {card.topics.slice(0, 2).map((tag, tagIndex) => (
              <button
                key={`${tag}-${tagIndex}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onTagClick(tag);
                }}
                className={clsx(
                  'pointer-events-auto max-w-[55%] truncate rounded px-1.5 py-0.5 text-[10px] font-medium',
                  highlightedTagsSet.has(tag.toLowerCase())
                    ? 'bg-indigo-500 text-white'
                    : 'bg-white/10 text-slate-200 hover:bg-white/20',
                )}
              >
                {tag}
              </button>
            ))}
            {card.topics.length > 2 && (
              <span className="shrink-0 py-0.5 text-[10px] text-slate-400">
                +{card.topics.length - 2}
              </span>
            )}
          </div>
        )}
        {card.vectorMatch?.text && (
          <p
            className="line-clamp-2 border-l-2 border-indigo-400 pl-2 text-xs text-indigo-200"
            title={card.vectorMatch.text}
          >
            <Sparkles className="mr-1 inline h-3 w-3" />
            {card.vectorMatch.text}
          </p>
        )}
        <div className="flex items-center justify-between gap-1 border-t border-white/15 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] tabular-nums text-slate-300">
            <span title="Stars" className="flex items-center gap-0.5">
              <Star className="h-3 w-3 text-amber-300" />
              {card.starCount || 0}
            </span>
            <span title="Favorites" className="flex items-center gap-0.5">
              <Heart className="h-3 w-3 text-rose-300" />
              {card.n_favorites || 0}
            </span>
          </div>
          <CardItemActions
            card={card}
            sourceUrl={chubUrl || card.sourceUrl || null}
            canPushToSilly={canPushToSilly}
            onToggleFavorite={onToggleFavorite}
            onDownload={onDownload}
            onPushToSilly={onPushToSilly}
            onCopyLink={onCopyLink}
            onDelete={onDelete}
          />
        </div>
      </div>
    </div>
  );
}
