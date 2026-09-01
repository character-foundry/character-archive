import type { Card } from "@/lib/types";

export type UrlCardResolution =
  | { action: "clear"; nextLast: null }
  | { action: "none"; nextLast: string | null }
  | { action: "open"; card: Card; nextLast: string };

export function resolveUrlCard(
  urlCardId: string | null,
  cards: Card[],
  lastHandledId: string | null,
  selectedCardId: string | number | null = null
): UrlCardResolution {
  if (!urlCardId) {
    return { action: "clear", nextLast: null };
  }
  if (cards.length === 0) {
    return { action: "none", nextLast: lastHandledId };
  }
  if (urlCardId === lastHandledId || urlCardId === String(selectedCardId ?? "")) {
    return { action: "none", nextLast: urlCardId };
  }

  const card = cards.find(c => c.id.toString() === urlCardId);
  if (!card) {
    return { action: "none", nextLast: lastHandledId };
  }

  return { action: "open", card, nextLast: urlCardId };
}
