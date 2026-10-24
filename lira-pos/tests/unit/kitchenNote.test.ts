/**
 * `lib/kitchenNote.ts` — the normalisation, the bound, and the merge rule
 * behind per-line kitchen instructions (WP-A2).
 *
 * Pure. The point of pinning these three functions here is that every one of
 * them has a counterpart on the other side of the wire — the normalisation
 * mirrors `posting.rs::normalize_kitchen_note`, the bound mirrors migration
 * 018's CHECK — and a drift between the two sides is not a cosmetic bug. The
 * note is compared on replay, so a client that normalised differently from the
 * backend would turn faithful retries of ordinary orders into conflicts.
 */
import { describe, expect, it } from "vitest";
import {
  KITCHEN_NOTE_MAX_CHARS,
  isKitchenNoteWithinLimit,
  kitchenNoteLength,
  kitchenNotesMerge,
  normalizeKitchenNote,
} from "../../src/lib/kitchenNote";

describe("normalising an instruction", () => {
  it("trims the edges", () => {
    expect(normalizeKitchenNote("  no pickles  ")).toBe("no pickles");
  });

  it("leaves interior spacing exactly as typed", () => {
    // The cashier's phrasing is theirs. Collapsing it would make the stored
    // instruction differ from the one approved at the till.
    expect(normalizeKitchenNote("no  pickles")).toBe("no  pickles");
  });

  it("treats blank, whitespace, null and undefined as NO instruction", () => {
    // NULL is the column's only way of saying "no instruction" (migration
    // 018's CHECK enforces it). A second way would fire the replay comparison
    // on carts that differ in nothing.
    for (const blank of ["", "   ", "\t", null, undefined]) {
      expect(normalizeKitchenNote(blank)).toBeNull();
    }
  });

  it("is idempotent", () => {
    const once = normalizeKitchenNote("  extra crispy ");
    expect(normalizeKitchenNote(once)).toBe(once);
  });

  it("keeps Arabic exactly", () => {
    expect(normalizeKitchenNote(" بدون صوص ")).toBe("بدون صوص");
  });
});

describe("the length bound", () => {
  it("accepts a note of exactly the limit", () => {
    expect(isKitchenNoteWithinLimit("x".repeat(KITCHEN_NOTE_MAX_CHARS))).toBe(true);
  });

  it("refuses one character more", () => {
    expect(isKitchenNoteWithinLimit("x".repeat(KITCHEN_NOTE_MAX_CHARS + 1))).toBe(false);
  });

  it("accepts an absent note", () => {
    expect(isKitchenNoteWithinLimit(null)).toBe(true);
    expect(isKitchenNoteWithinLimit("")).toBe(true);
  });

  it("measures the limit AFTER trimming", () => {
    // Otherwise a note the backend would accept — it trims too — is refused at
    // the till for whitespace nobody can see.
    const atLimit = "x".repeat(KITCHEN_NOTE_MAX_CHARS);
    expect(isKitchenNoteWithinLimit(`  ${atLimit}  `)).toBe(true);
  });

  it("counts CODE POINTS, not UTF-16 units", () => {
    // SQLite's `length()` counts characters for TEXT, so the bound has to as
    // well. An emoji is two UTF-16 units and one character: measuring with
    // `.length` would refuse a note the column accepts.
    expect(kitchenNoteLength("🍔")).toBe(1);
    expect("🍔".length).toBe(2);
    expect(isKitchenNoteWithinLimit("🍔".repeat(KITCHEN_NOTE_MAX_CHARS))).toBe(true);
  });

  it("counts Arabic letters as one each", () => {
    // 200 Arabic letters is 400 bytes. A byte bound would refuse it; the
    // column does not.
    expect(kitchenNoteLength("ص".repeat(200))).toBe(200);
    expect(isKitchenNoteWithinLimit("ص".repeat(200))).toBe(true);
  });
});

describe("the merge rule", () => {
  it("merges two lines with no instruction", () => {
    expect(kitchenNotesMerge(null, undefined)).toBe(true);
    expect(kitchenNotesMerge("", "   ")).toBe(true);
  });

  it("merges two lines carrying the SAME instruction", () => {
    expect(kitchenNotesMerge("no pickles", " no pickles ")).toBe(true);
  });

  it("does NOT merge a plain line into a noted one", () => {
    // THE rule the feature depends on. Merging on product and unit alone would
    // fold a plain burger into the one marked "no pickles" and have the kitchen
    // make both of them wrong, with nothing on the receipt to show it.
    expect(kitchenNotesMerge(null, "no pickles")).toBe(false);
    expect(kitchenNotesMerge("no pickles", null)).toBe(false);
  });

  it("does NOT merge two different instructions", () => {
    expect(kitchenNotesMerge("no pickles", "extra pickles")).toBe(false);
  });

  it("is case- and content-sensitive, because the kitchen reads it literally", () => {
    // Deliberately NOT case-folded: "NO ONIONS" and "no onions" are the same
    // request, but folding them would mean storing one and displaying the
    // other, and the stored text is what the kitchen ticket prints.
    expect(kitchenNotesMerge("no onions", "NO ONIONS")).toBe(false);
  });
});
