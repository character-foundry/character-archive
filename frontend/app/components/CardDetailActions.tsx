import { useState } from 'react';
import { CloudDownload, Copy, Download, Globe, Heart, Loader2, RefreshCw, Send } from 'lucide-react';
import clsx from 'clsx';
import type { Card } from '@/lib/types';

interface CardDetailActionsProps {
  card: Card;
  sourceUrl: string | null;
  refreshing: boolean;
  canPushToSilly: boolean;
  canPushToArchitect: boolean;
  onFavorite: (card: Card) => void;
  onRefresh: (card: Card, mode?: 'local' | 'source') => void;
  onDownload: (card: Card) => void;
  onPushToSilly: (card: Card) => void;
  onPushToArchitect: (card: Card) => void;
  onCopyLink: (card: Card) => void;
}

const buttonClass =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60';
const neutralClass =
  'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';

export function CardDetailActions({
  card,
  sourceUrl,
  refreshing,
  canPushToSilly,
  canPushToArchitect,
  onFavorite,
  onRefresh,
  onDownload,
  onPushToSilly,
  onPushToArchitect,
  onCopyLink,
}: CardDetailActionsProps) {
  const [lumiverseStatus, setLumiverseStatus] = useState('');
  const [sendingLumiverse, setSendingLumiverse] = useState(false);
  async function sendToLumiverse() {
    setSendingLumiverse(true);
    setLumiverseStatus('');
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/push-to-lumiverse`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Send failed');
      setLumiverseStatus('Sent to Lumiverse');
    } catch (error) { setLumiverseStatus(error instanceof Error ? error.message : 'Send failed'); }
    finally { setSendingLumiverse(false); }
  }
  const favoriteLabel = card.favorited ? 'Remove favorite' : 'Add favorite';
  return (
    <div role="group" aria-label="Card actions" className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onFavorite(card)}
        title={favoriteLabel}
        aria-label={favoriteLabel}
        aria-pressed={!!card.favorited}
        className={clsx(
          buttonClass,
          'w-8',
          card.favorited
            ? 'border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10'
            : neutralClass,
        )}
      >
        <Heart className={clsx('h-4 w-4', card.favorited && 'fill-current')} />
      </button>
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          title="View source"
          aria-label="View source"
          className={`${buttonClass} ${neutralClass} w-8`}
        >
          <Globe className="h-4 w-4" />
        </a>
      )}
      <button
        type="button"
        onClick={() => onRefresh(card)}
        disabled={refreshing}
        title="Reload saved card"
        aria-label="Reload saved card"
        className={`${buttonClass} ${neutralClass} w-8`}
      >
        {refreshing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onRefresh(card, 'source')}
        disabled={refreshing}
        title="Update from source"
        aria-label="Update from source"
        className={`${buttonClass} ${neutralClass} w-8`}
      >
        <CloudDownload className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onDownload(card)}
        title="Download PNG"
        aria-label="Download PNG"
        className={`${buttonClass} w-8 border-transparent bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200`}
      >
        <Download className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onPushToSilly(card)}
        disabled={!canPushToSilly}
        title={
          canPushToSilly
            ? 'Send this card to Silly Tavern'
            : 'Enable Silly Tavern integration in settings first'
        }
        aria-label="Send to Silly Tavern"
        className={`${buttonClass} border-emerald-200 px-2 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-600/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10`}
      >
        <Send className="h-4 w-4" /> Silly Tavern
      </button>
      <button
        type="button"
        onClick={() => onPushToArchitect(card)}
        disabled={!canPushToArchitect}
        title={
          canPushToArchitect
            ? 'Send this card to Character Architect'
            : 'Configure Character Architect URL in settings first'
        }
        aria-label="Send to Character Architect"
        className={`${buttonClass} border-purple-200 px-2 text-purple-600 hover:bg-purple-50 dark:border-purple-600/40 dark:text-purple-300 dark:hover:bg-purple-500/10`}
      >
        <Send className="h-4 w-4" /> Character Architect
      </button>
      <button type="button" disabled={sendingLumiverse} onClick={sendToLumiverse} className={`${buttonClass} ${neutralClass} px-2`}>
        <Send className="h-4 w-4" /> {sendingLumiverse ? 'Sending…' : 'Lumiverse'}
      </button>
      {lumiverseStatus && <span role="status" className="text-xs">{lumiverseStatus}</span>}
      <button
        type="button"
        onClick={() => onCopyLink(card)}
        title="Copy image URL"
        aria-label="Copy image URL"
        className={`${buttonClass} ${neutralClass} px-2`}
      >
        <Copy className="h-4 w-4" /> Image URL
      </button>
    </div>
  );
}
