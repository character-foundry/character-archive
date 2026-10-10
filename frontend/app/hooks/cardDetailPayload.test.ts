import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCardDetailPayload } from "./cardDetailPayload";
import { useCardDetails } from "./useCardDetails";
import { useCardActions } from "./useCardActions";
import type { Card } from "@/lib/types";

const definition = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Fixture",
    description: "Character description",
    first_mes: "First greeting",
    alternate_greetings: ["Another greeting"],
    character_book: { entries: [{ name: "Setting", content: "Lore content" }] },
  },
};

// Exercise the real hook's derived sections with the loaded endpoint payloads.
// Server rendering needs no DOM and does not run gallery/cache effects.
function displayPayload(
  payload: Awaited<ReturnType<typeof loadCardDetailPayload>>,
  assertDisplay: (display: ReturnType<typeof useCardDetails>) => void,
) {
  function CardDisplay() {
    const details = useCardDetails([], () => {});
    const [initialized, setInitialized] = useState(false);
    if (!initialized) {
      details.setCardDetails({ ...payload, gallery: [], galleryError: null });
      setInitialized(true);
      return null;
    }
    assertDisplay(details);
    return null;
  }
  renderToStaticMarkup(createElement(CardDisplay));
}

test("metadata without a definition still displays embedded character sections", async (t) => {
  // Metadata-only Chub updates can retain listing fields while the definition
  // remains available through the existing embedded-data endpoint.
  const metadata = { name: "Fixture", description: "Listing summary" };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests.push(input);
    if (input.endsWith("/metadata")) return Response.json(metadata);
    if (input.endsWith("/png-info")) return Response.json({ data: definition });
    throw new Error(`Unexpected request: ${input}`);
  });

  const payload = await loadCardDetailPayload("123");
  displayPayload(payload, display => {
    assert.deepEqual(display.textSections.map(({ title }) => title), ["Description", "First Message"]);
    assert.equal(display.resolveTextField("description"), "Character description");
    assert.deepEqual(display.alternateGreetings, ["Another greeting"]);
    assert.deepEqual(display.lorebookEntries, definition.data.character_book.entries);
  });
  assert.deepEqual(payload.metadata, metadata);
  assert.deepEqual(requests, ["/api/cards/123/metadata", "/api/cards/123/png-info"]);
});

for (const [shape, metadata] of Object.entries({
  "wrapped v2": { definition },
  "wrapped v3": { definition: { ...definition, spec: "chara_card_v3", spec_version: "3.0" } },
  "direct data": { data: definition.data },
  "flat definition": { definition: definition.data },
  "malformed definition with valid data": { definition: { data: "invalid" }, data: definition.data },
})) {
  test(`${shape} metadata displays sections without fetching embedded data`, async (t) => {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string) => {
      requests.push(input);
      return Response.json(metadata);
    });

    const payload = await loadCardDetailPayload("123");
    displayPayload(payload, display => {
      assert.equal(display.resolveTextField("first_mes"), "First greeting");
      assert.deepEqual(display.alternateGreetings, ["Another greeting"]);
      assert.deepEqual(display.lorebookEntries, definition.data.character_book.entries);
    });
    assert.equal(payload.pngInfo, null);
    assert.deepEqual(requests, ["/api/cards/123/metadata"]);
  });
}

for (const [shape, data] of Object.entries({
  "greetings only": { alternate_greetings: ["Another greeting"] },
  "lorebook only": { character_book: definition.data.character_book },
})) {
  test(`${shape} definitions count as parsed content`, async (t) => {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string) => {
      requests.push(input);
      return Response.json({ definition: { data } });
    });

    displayPayload(await loadCardDetailPayload("123"), display => {
      assert.ok(display.alternateGreetings.length + display.lorebookEntries.length > 0);
    });
    assert.deepEqual(requests, ["/api/cards/123/metadata"]);
  });
}

for (const [shape, metadata] of Object.entries({
  "empty definition": { definition: {} },
  "empty wrapped definition": { definition: { data: {} } },
  "malformed definition": { definition: { data: "invalid" } },
  "array definition": { definition: { data: [] } },
  "blank content": { definition: { data: {
    description: "  ", first_mes: 42, alternate_greetings: [null, " "],
    character_book: { entries: [null] },
  } } },
})) {
  test(`${shape} does not suppress the embedded-data fallback`, async (t) => {
    t.mock.method(globalThis, "fetch", async (input: string) => Response.json(
      input.endsWith("/metadata") ? metadata : { data: definition }
    ));

    displayPayload(await loadCardDetailPayload("123"), display => {
      assert.equal(display.resolveTextField("first_mes"), "First greeting");
      assert.deepEqual(display.alternateGreetings, ["Another greeting"]);
    });
  });
}

for (const [shape, spec] of Object.entries({
  "flat v1": definition.data,
  "wrapped v3": { ...definition, spec: "chara_card_v3", spec_version: "3.0" },
})) {
  test(`${shape} embedded data displays when metadata is missing`, async (t) => {
    t.mock.method(globalThis, "fetch", async (input: string) => input.endsWith("/metadata")
      ? Response.json({ error: "Metadata not found" }, { status: 404 })
      : Response.json({ data: spec })
    );

    const payload = await loadCardDetailPayload("123");
    assert.equal(payload.metadata, null);
    displayPayload(payload, display => {
      assert.equal(display.resolveTextField("description"), "Character description");
      assert.equal(display.resolveTextField("first_mes"), "First greeting");
      assert.deepEqual(display.lorebookEntries, definition.data.character_book.entries);
    });
  });
}

test("a metadata network failure still tries embedded data", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input.endsWith("/metadata")) throw new Error("Network failure");
    return Response.json({ data: definition });
  });

  displayPayload(await loadCardDetailPayload("123"), display => {
    assert.equal(display.resolveTextField("first_mes"), "First greeting");
  });
});

test("unavailable embedded data preserves raw metadata and ancillary sections", async (t) => {
  const metadata = {
    name: "Fixture",
    labels: [{ title: "TOKEN_COUNTS", description: '{"total":100}' }],
    related_lorebooks: [{ name: "Linked lorebook", fullPath: "author/lorebook" }],
  };
  t.mock.method(globalThis, "fetch", async (input: string) => input.endsWith("/metadata")
    ? Response.json(metadata)
    : Response.json({ error: "No embedded data found" }, { status: 404 })
  );

  const payload = await loadCardDetailPayload("123");
  assert.deepEqual(payload.metadata, metadata);
  assert.equal(payload.pngInfo, null);
  displayPayload(payload, display => {
    assert.deepEqual(display.textSections, []);
    assert.deepEqual(display.tokenCounts, { total: 100 });
    assert.deepEqual(display.linkedLorebooks, metadata.related_lorebooks);
  });
});

test("missing metadata and embedded data leave an empty display without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 404 }));

  const payload = await loadCardDetailPayload("123");
  assert.deepEqual(payload, { metadata: null, pngInfo: null });
  displayPayload(payload, display => {
    assert.deepEqual(display.textSections, []);
    assert.deepEqual(display.alternateGreetings, []);
    assert.deepEqual(display.lorebookEntries, []);
  });
});

function cardActions() {
  let actions: ReturnType<typeof useCardActions> | undefined;
  function CardActions() {
    // Test harness: capture callbacks once without mounting a browser or running effects.
    // eslint-disable-next-line react-hooks/globals
    actions = useCardActions();
    return null;
  }
  renderToStaticMarkup(createElement(CardActions));
  assert.ok(actions);
  return actions;
}

const card: Card = {
  id: "123", name: "Fixture", topics: [], id_prefix: "", author: "",
  tagline: "", description: "", imagePath: "", tokenCount: 0,
  lastModified: "", createdAt: "", nChats: 0, nMessages: 0, n_favorites: 0,
  starCount: 0, rating: 0, ratingCount: 0, ratings: "", fullPath: "",
  language: "", favorited: 0, visibility: "", source: "chub",
  hasAlternateGreetings: false, hasLorebook: false, hasEmbeddedLorebook: false,
  hasLinkedLorebook: false, hasExampleDialogues: false, hasSystemPrompt: false,
  hasGallery: false, hasEmbeddedImages: false, hasExpressions: false,
};

test("reloading a saved card reads details without updating its source or listing", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requests.push(input);
    return Response.json(input.endsWith("/metadata") ? {} : { data: definition });
  });
  let listingReloaded = false;
  let displayed: Card | undefined;
  let payload: Awaited<ReturnType<typeof loadCardDetailPayload>> | undefined;
  await cardActions().handleRefreshCard(card, async () => {
    listingReloaded = true;
  }, async selected => {
    displayed = selected;
    payload = await loadCardDetailPayload(selected.id);
  });
  assert.equal(listingReloaded, false);
  assert.equal(displayed, card);
  assert.ok(payload);
  displayPayload(payload, display => {
    assert.equal(display.resolveTextField("first_mes"), "First greeting");
  });
  assert.deepEqual(requests, ["/api/cards/123/metadata", "/api/cards/123/png-info"]);
});

test("an explicit source update reloads the updated card", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    requests.push(`${init?.method} ${input}`);
    return Response.json({ success: true });
  });
  const updated = { ...card, name: "Updated fixture" };
  let displayed: Card | undefined;
  await cardActions().handleRefreshCard(card, async () => ({ cards: [updated] }), async selected => {
    displayed = selected;
  }, "source");
  assert.deepEqual(requests, ["POST /api/cards/123/refresh"]);
  assert.equal(displayed, updated);
});

test("a missing source leaves the current saved details intact and reports its error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(
    { error: "Source card no longer exists" }, { status: 404 }
  ));
  const errors: unknown[] = [];
  t.mock.method(console, "error", (error: unknown) => errors.push(error));
  let listingReloaded = false;
  let detailsReplaced = false;
  await cardActions().handleRefreshCard(card, async () => {
    listingReloaded = true;
  }, async () => {
    detailsReplaced = true;
  }, "source");
  assert.equal(listingReloaded, false);
  assert.equal(detailsReplaced, false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal(errors[0].message, "Source card no longer exists");
});
