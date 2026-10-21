/**
 * What a NEW product starts on, before the operator has chosen anything.
 *
 * Pure, no React, no DB. Extracted so the two rules below can be tested
 * directly, because both of them were defects found by the Stress 001 campaign
 * and both are the kind that cannot be corrected after the fact: a sale line
 * SNAPSHOTS the VAT rate and the stock unit at posting, so a product created
 * under the wrong one poisons every sale of it until someone notices, and the
 * sales already posted stay wrong for ever.
 *
 * The shared principle: a default is only legitimate when it is the answer a
 * reasonable operator would have given anyway. Where no such answer exists,
 * these functions return nothing and the caller must make the operator choose.
 * "Whatever happened to sort first" is never that answer.
 */

import type { UnitOfMeasure, VatRate } from "../db/types";

/**
 * Stock units that mean "one countable item", best first.
 *
 * `uomsRepo.listActive` orders by `category, name`, so the first row of the
 * seeded catalog is **Box** — which is how a burger came to be stocked and
 * sold in boxes (GZ-WP0-02). The fix is to choose by a stable code, never by
 * array position, and these are the only two codes that mean a single piece.
 */
export const PIECE_UOM_CODES = ["pcs", "each"] as const;

/**
 * The stock unit a new product should start on, or `null` when none of the
 * piece units is configured.
 *
 * Null rather than `uoms[0]`: if this catalog genuinely has no piece unit, the
 * right answer is to make the operator pick, not to stock a hamburger in
 * kilograms because "kg" happened to sort first. The caller renders an empty
 * selection and the existing required-field validation does the rest.
 */
export function preferredBaseUomCode(uoms: UnitOfMeasure[]): string | null {
  for (const code of PIECE_UOM_CODES) {
    if (uoms.some((u) => u.code === code)) return code;
  }
  return null;
}

/**
 * The VAT rate a new product should start on: **none, ever**.
 *
 * The form used to preselect `vatRates[0]`, which the repo returns as
 * **Exempt** — so a manager who typed a name and a price and pressed Create got
 * a VAT-exempt product, and the till then charged no output VAT on every sale
 * of it (GZ-WP0-01). Greaz is VAT-registered at the standard rate, so Exempt is
 * the one choice that is almost never right.
 *
 * Preselecting the standard rate instead was rejected: it trades a silently
 * wrong answer for a silently right-looking one, and the operator still never
 * reads the field. A genuinely exempt product — which Greaz does support — is
 * then one deliberate choice away, exactly as a standard-rated one is.
 *
 * This is a function rather than a constant so the rule has one name, one
 * docstring and one test, instead of an empty string copied into two places.
 */
export function defaultVatRateIdForNewProduct(): string {
  return "";
}

/**
 * Is this id one of the catalog's VAT rates?
 *
 * Used to decide whether a *restored or imported* id is still meaningful. An
 * id that no longer resolves must be treated as unchosen rather than quietly
 * carried into `save_product`, where it would fail the foreign key with a
 * database error instead of a sentence the operator can act on.
 */
export function isKnownVatRateId(
  vatRateId: string | null | undefined,
  vatRates: VatRate[],
): boolean {
  if (!vatRateId) return false;
  return vatRates.some((v) => v.id === vatRateId);
}

/**
 * The guard every catalog write passes through, whatever called it.
 *
 * Lives here rather than in the Products page because the page is not the only
 * creation path — the spreadsheet importer writes products too, and a rule
 * enforced in one screen is not a rule. `productsRepo.save` calls this, so the
 * form, the importer and any future caller are all covered by construction.
 *
 * Throws rather than returning a result: there is no sensible way to continue,
 * and every caller already renders a thrown message.
 */
export function assertVatRateChosen(vatRateId: string | null | undefined): string {
  const id = (vatRateId ?? "").trim();
  if (id === "") {
    throw new Error(
      "A VAT rate must be chosen explicitly. Leaving it unset would create the " +
        "product as VAT-exempt, and sales of it snapshot that rate permanently.",
    );
  }
  return id;
}
