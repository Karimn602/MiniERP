import { describe, expect, it } from "vitest";
import {
  PIECE_UOM_CODES,
  assertVatRateChosen,
  defaultVatRateIdForNewProduct,
  isKnownVatRateId,
  preferredBaseUomCode,
} from "../../src/lib/catalogDefaults";
import type { UnitOfMeasure, VatRate } from "../../src/db/types";

/**
 * GZ-WP0-01 and GZ-WP0-02 — the two "silent default" defects Stress 001 found.
 *
 * Both are unrecoverable after the fact: `sale_items` snapshots the VAT rate
 * and the selling unit at posting, so a product created under a wrong default
 * poisons every sale of it and the sales already posted stay wrong for ever.
 * These tests exist to make sure neither default comes back.
 */

function uom(code: string, name: string, category: UnitOfMeasure["category"] = "count"): UnitOfMeasure {
  return { code, name, category, symbol: code, isActive: true };
}

function vat(id: string, name: string, rateBps: number, isExempt: boolean): VatRate {
  return {
    id,
    name,
    rateBps,
    isExempt,
    effectiveFrom: "2018-01-01",
  } as VatRate;
}

// The catalog exactly as migration 004 seeds it, in the order
// `uomsRepo.listActive` returns it (ORDER BY category, name) — which is what
// put "Box" first and sold hamburgers by the box.
const SEEDED_UOMS: UnitOfMeasure[] = [
  uom("box", "Box"),
  uom("case", "Case"),
  uom("dozen", "Dozen"),
  uom("each", "Each"),
  uom("pack", "Pack"),
  uom("pcs", "Pieces"),
  uom("g", "Grams", "weight"),
  uom("kg", "Kilograms", "weight"),
];

// `vatRatesRepo.listActive` order, which is what made Exempt the default.
const SEEDED_VAT: VatRate[] = [
  vat("00000000-0000-0000-0000-000000000012", "Exempt", 0, true),
  vat("00000000-0000-0000-0000-000000000010", "Standard 11%", 1100, false),
  vat("00000000-0000-0000-0000-000000000011", "Zero-rated 0%", 0, false),
];

describe("preferredBaseUomCode (GZ-WP0-02)", () => {
  it("chooses Pieces from the seeded catalog, NOT the first row", () => {
    // The regression in one line: uoms[0].code is "box".
    expect(SEEDED_UOMS[0].code).toBe("box");
    expect(preferredBaseUomCode(SEEDED_UOMS)).toBe("pcs");
  });

  it("falls back to Each when Pieces is not configured", () => {
    const withoutPcs = SEEDED_UOMS.filter((u) => u.code !== "pcs");
    expect(preferredBaseUomCode(withoutPcs)).toBe("each");
  });

  it("returns null rather than an arbitrary unit when no piece unit exists", () => {
    // A hamburger must not end up stocked in kilograms because "kg" sorted
    // first. Null makes the caller render an empty selection, and the form's
    // required-unit validation then stops the save.
    const weightOnly = [uom("g", "Grams", "weight"), uom("kg", "Kilograms", "weight")];
    expect(preferredBaseUomCode(weightOnly)).toBeNull();
    expect(preferredBaseUomCode([])).toBeNull();
  });

  it("never returns a code that is not in the catalog it was given", () => {
    for (const cat of [SEEDED_UOMS, SEEDED_UOMS.slice(2), [uom("each", "Each")], []]) {
      const got = preferredBaseUomCode(cat);
      if (got !== null) expect(cat.some((u) => u.code === got)).toBe(true);
    }
  });

  it("prefers pcs over each wherever both exist, whatever the array order", () => {
    expect(PIECE_UOM_CODES).toEqual(["pcs", "each"]);
    expect(preferredBaseUomCode([uom("each", "Each"), uom("pcs", "Pieces")])).toBe("pcs");
    expect(preferredBaseUomCode([uom("pcs", "Pieces"), uom("each", "Each")])).toBe("pcs");
  });
});

describe("defaultVatRateIdForNewProduct (GZ-WP0-01)", () => {
  it("is empty — a new product carries NO preselected VAT rate", () => {
    expect(defaultVatRateIdForNewProduct()).toBe("");
  });

  it("is not the first rate the repo returns, which is Exempt", () => {
    // The defect, stated as a test: taking vatRates[0] gives you Exempt, at
    // 0 bps, on a VAT-registered business.
    expect(SEEDED_VAT[0].name).toBe("Exempt");
    expect(SEEDED_VAT[0].rateBps).toBe(0);
    expect(SEEDED_VAT[0].isExempt).toBe(true);
    expect(defaultVatRateIdForNewProduct()).not.toBe(SEEDED_VAT[0].id);
  });

  it("is not silently the standard rate either", () => {
    // Preselecting 11% would trade a silently wrong answer for a
    // silently-right-looking one, and the operator still never reads the field.
    const standard = SEEDED_VAT.find((v) => v.rateBps === 1100)!;
    expect(defaultVatRateIdForNewProduct()).not.toBe(standard.id);
  });

  it("does not resolve to any rate in the catalog", () => {
    expect(isKnownVatRateId(defaultVatRateIdForNewProduct(), SEEDED_VAT)).toBe(false);
  });
});

describe("isKnownVatRateId", () => {
  it("accepts an id the catalog holds", () => {
    expect(isKnownVatRateId(SEEDED_VAT[1].id, SEEDED_VAT)).toBe(true);
  });

  it("rejects empty, null, undefined and unknown ids", () => {
    for (const bad of ["", null, undefined, "not-a-rate"]) {
      expect(isKnownVatRateId(bad, SEEDED_VAT)).toBe(false);
    }
  });

  it("rejects a stale id after the rate is gone, so it is re-chosen not carried", () => {
    const retired = SEEDED_VAT[1].id;
    expect(isKnownVatRateId(retired, SEEDED_VAT.filter((v) => v.id !== retired))).toBe(false);
  });
});

describe("assertVatRateChosen — the guard every catalog write passes (GZ-WP0-01)", () => {
  it("refuses an unspecified rate rather than letting it become Exempt", () => {
    for (const bad of ["", "   ", "\t", null, undefined]) {
      expect(() => assertVatRateChosen(bad)).toThrow(/VAT rate must be chosen explicitly/i);
    }
  });

  it("names the consequence, so the refusal is actionable", () => {
    expect(() => assertVatRateChosen("")).toThrow(/exempt/i);
    expect(() => assertVatRateChosen("")).toThrow(/snapshot/i);
  });

  it("passes a real id straight through, trimmed", () => {
    expect(assertVatRateChosen(SEEDED_VAT[1].id)).toBe(SEEDED_VAT[1].id);
    expect(assertVatRateChosen("  rate-1  ")).toBe("rate-1");
  });

  it("still allows a DELIBERATE exempt product — exemption is supported, not banned", () => {
    const exempt = SEEDED_VAT[0];
    expect(assertVatRateChosen(exempt.id)).toBe(exempt.id);
  });
});
