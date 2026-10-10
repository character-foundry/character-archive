import { fetchCardMetadata, fetchPngInfo } from "@/lib/api";

type CardPayload = Record<string, unknown>;

function asRecord(value: unknown): CardPayload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as CardPayload
    : null;
}

function hasDisplayContent(data: CardPayload | null): data is CardPayload {
  if (!data) return false;
  const textFields = [
    "description", "scenario", "personality", "first_mes", "mes_example",
    "system_prompt", "post_history_instructions",
  ];
  if (textFields.some(key => typeof data[key] === "string" && data[key].trim())) return true;
  if (Array.isArray(data.alternate_greetings) && data.alternate_greetings.some(
    value => typeof value === "string" && value.trim()
  )) return true;
  const entries = asRecord(data.character_book)?.entries;
  return Array.isArray(entries) && entries.some(entry => asRecord(entry) !== null);
}

export function getDefinitionData(metadata: CardPayload | null): CardPayload | null {
  const definition = asRecord(metadata?.definition);
  // Stored metadata can contain a wrapped v2/v3 definition, a direct data
  // object, or a flat definition. Empty/malformed wrappers must not hide data.
  return [asRecord(definition?.data), asRecord(metadata?.data), definition]
    .find(hasDisplayContent) ?? null;
}

export function getEmbeddedDefinitionData(pngInfo: CardPayload | null): CardPayload | null {
  // /png-info wraps the spec in `data`; v1 specs have no inner `data` wrapper.
  const spec = asRecord(pngInfo?.data);
  return asRecord(spec?.data) ?? spec;
}

export async function loadCardDetailPayload(cardId: string) {
  const metadata = asRecord(await fetchCardMetadata(cardId).catch(() => null));
  // Metadata-only updates may omit the definition while the archived card
  // still contains it. Use the existing endpoint only when metadata is insufficient.
  const pngInfo = getDefinitionData(metadata)
    ? null
    : asRecord(await fetchPngInfo(cardId).catch(() => null));
  return { metadata, pngInfo };
}
