import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { Copy, Download, Globe, Heart, MoreHorizontal, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { Card } from '@/lib/types';

interface CardItemActionsProps {
  card: Card;
  sourceUrl: string | null;
  canPushToSilly: boolean;
  onToggleFavorite: (card: Card) => void;
  onDownload: (card: Card) => void;
  onPushToSilly: (card: Card) => void;
  onCopyLink: (card: Card) => void;
  onDelete: (card: Card) => void;
}

const actionClass =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300';
const menuItemClass =
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm data-[focus]:bg-slate-100 dark:data-[focus]:bg-slate-800 data-[disabled]:opacity-40';

export function CardItemActions({
  card,
  sourceUrl,
  canPushToSilly,
  onToggleFavorite,
  onDownload,
  onPushToSilly,
  onCopyLink,
  onDelete,
}: CardItemActionsProps) {
  return (
    <div
      className="pointer-events-auto flex items-center gap-0.5"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => onToggleFavorite(card)}
        aria-label={card.favorited ? 'Remove favorite' : 'Add favorite'}
        title={card.favorited ? 'Remove favorite' : 'Add favorite'}
        aria-pressed={!!card.favorited}
        className={clsx(actionClass, card.favorited && 'text-rose-300')}
      >
        <Heart className={clsx('h-4 w-4', card.favorited && 'fill-current')} />
      </button>
      <button
        type="button"
        onClick={() => onDownload(card)}
        aria-label="Download PNG"
        title="Download PNG"
        className={actionClass}
      >
        <Download className="h-4 w-4" />
      </button>
      <Menu>
        <MenuButton
          aria-label={`More actions for ${card.name}`}
          title="More actions"
          className={actionClass}
        >
          <MoreHorizontal className="h-4 w-4" />
        </MenuButton>
        <MenuItems
          anchor="bottom end"
          portal
          className="z-[60] min-w-48 rounded-lg border border-slate-200 bg-white p-1 text-slate-700 shadow-xl [--anchor-gap:4px] focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {sourceUrl && (
            <MenuItem>
              <a href={sourceUrl} target="_blank" rel="noreferrer" className={menuItemClass}>
                <Globe className="h-4 w-4" />
                View source
              </a>
            </MenuItem>
          )}
          <MenuItem disabled={!canPushToSilly}>
            <button onClick={() => onPushToSilly(card)} className={menuItemClass}>
              <Send className="h-4 w-4" />
              Push to SillyTavern
            </button>
          </MenuItem>
          <MenuItem>
            <button onClick={() => onCopyLink(card)} className={menuItemClass}>
              <Copy className="h-4 w-4" />
              Copy image URL
            </button>
          </MenuItem>
          <MenuItem>
            <button
              onClick={() => onDelete(card)}
              className={`${menuItemClass} text-rose-600 dark:text-rose-300`}
            >
              <Trash2 className="h-4 w-4" />
              Delete card
            </button>
          </MenuItem>
        </MenuItems>
      </Menu>
    </div>
  );
}
