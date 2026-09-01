import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUrlCard } from "./urlCard";

const cards = [
  { id: 1, name: "One" },
  { id: 2, name: "Two" },
] as const;

test("clears selection when URL card id is absent", () => {
  const result = resolveUrlCard(null, cards as any, "2");
  assert.equal(result.action, "clear");
  assert.equal(result.nextLast, null);
});

test("does nothing while cards are still loading", () => {
  const result = resolveUrlCard("2", [], null);
  assert.equal(result.action, "none");
  assert.equal(result.nextLast, null);
});

test("opens once cards arrive and only once per id", () => {
  const first = resolveUrlCard("2", cards as any, null);
  assert.equal(first.action, "open");
  assert.equal(first.nextLast, "2");
  assert.equal((first as any).card.id, 2);

  const second = resolveUrlCard("2", cards as any, first.nextLast);
  assert.equal(second.action, "none");
  assert.equal(second.nextLast, "2");
});

test("does not reopen a card that the click handler already selected", () => {
  const result = resolveUrlCard("2", cards as any, null, "2");
  assert.equal(result.action, "none");
  assert.equal(result.nextLast, "2");
});

test("ignores URL ids not present in cards list", () => {
  const result = resolveUrlCard("99", cards as any, null);
  assert.equal(result.action, "none");
  assert.equal(result.nextLast, null);
});
