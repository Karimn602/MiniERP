/**
 * Per-line kitchen instructions — the normalisation, the bound, and the
 * merge rule. Pure: no React, no database, no `invoke`.
 *
 * ## What a note is, and what it must never become
 *
 * "No pickles". "Light sauce". "بدون صوص". A preparation instruction attached
 * to ONE order line, so the kitchen makes that burger differently from the
 * identical burger beside it on the same receipt.
 *
 * It carries NO money. Not a price, not a VAT figure, not a discount, not a
 * COGS rate, not an ingredient. A PAID modifier — extra cheddar, a large
 * upgrade — is a priced line of its own and stays one, because the moment free
 * text starts carrying money the receipt stops reconciling to its lines and
 * nobody can say which notes were charged for. Migration 018 states the whole
 * boundary; this module is the client half of it.
 *
 * ## Why the normalisation is shared and not done at each call site
 *
 * The note is part of the sale's CANONICAL content: `post_sale` compares it on
 * replay, so a retry that arrives with a different instruction is refused as a
 * conflict (which is right — nothing can edit a posted line, so an accepted
 * difference would be permanent and invisible). That makes the exact bytes
 * matter. `posting.rs::normalize_kitchen_note` trims and treats blank as
 * absent; if the register stored `"  "` and the backend stored NULL, a
 * perfectly faithful retry would read as a conflict. So the two sides perform
 * the same reduction, and this is the one place the client does it.
 *
 * `MAX_CHARS` mirrors migration 018's CHECK for the same reason: the cashier
 * finds out at the till, in a sentence, rather than at post time in a
 * constraint failure. Characters, not bytes — SQLite's `length()` counts
 * characters for TEXT, and the staff type Arabic at two bytes a letter.
 */

/** The longest instruction a line may carry. Migration 018's CHECK, in TS. */
export const KITCHEN_NOTE_MAX_CHARS = 200;

/**
 * The canonical form of a typed instruction, or `null` for none.
 *
 * `null` rather than `""`: NULL is the column's only way of saying "no
 * instruction", and keeping a second one would make the replay comparison
 * fire on carts that differ in nothing.
 *
 * Interior whitespace is left exactly as typed. "no  pickles" is the cashier's
 * phrasing, not an error to correct, and rewriting it would make the stored
 * instruction differ from the one approved at the till.
 */
export function normalizeKitchenNote(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Is this instruction short enough to post? */
export function isKitchenNoteWithinLimit(raw: string | null | undefined): boolean {
  const note = normalizeKitchenNote(raw);
  return note === null || [...note].length <= KITCHEN_NOTE_MAX_CHARS;
}

/**
 * Length as the database counts it — characters, not UTF-16 code units.
 *
 * `"x".length` and `[...x].length` disagree on anything outside the BMP (an
 * emoji is two code units), and the column's bound is characters. A counter
 * that used `.length` would refuse a note SQLite would accept.
 */
export function kitchenNoteLength(raw: string | null | undefined): number {
  const note = normalizeKitchenNote(raw);
  return note === null ? 0 : [...note].length;
}

/**
 * May a newly added unit of a product join an existing cart line?
 *
 * This is the WP-A2 merge rule, and it exists because the old one — same
 * product, same selling unit — would have quietly destroyed the feature. Two
 * burgers with different instructions ARE different lines, and clicking the
 * tile a third time must not fold a plain burger into the one marked "no
 * pickles": the kitchen would make three of them wrong and the receipt would
 * never show that anything had been asked for.
 *
 * Stated as a predicate over the NORMALISED notes, so an untouched line and
 * one whose note was cleared back to blank are the same line again, and a
 * cart round-tripped through JSON (where `undefined` disappears) still merges
 * the way it did before it was parked.
 *
 * The consequence, and it is deliberate: a tile click lands on the first line
 * with no instruction, so the way to get two different notes is to note the
 * first line and click again. A note therefore applies to a whole line — all
 * three of a line of three — which is the honest reading of one instruction
 * attached to one line, and the cashier splits a line by decrementing it and
 * adding the odd one back.
 */
export function kitchenNotesMerge(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeKitchenNote(a) === normalizeKitchenNote(b);
}
