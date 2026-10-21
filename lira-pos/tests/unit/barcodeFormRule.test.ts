import { describe, expect, it } from "vitest";
import {
  failsEan13Checksum,
  isValidEan13,
  productFormBarcodeError,
} from "../../src/lib/barcode";

/**
 * GZ-WP2-A — a historical barcode must not make a product uneditable.
 *
 * The Products form ran its EAN-13 check on every save, including an update
 * that submits no barcode at all. Real shelf stock carries codes that fail the
 * modern checksum — a mis-keyed label, a re-used internal number, a supplier's
 * own scheme — and those products are sellable. The form made them permanently
 * unmaintainable: a price rise or a spelling fix was refused over a field the
 * save would not have written.
 */

/** A real EAN-13, and the same digits with the check digit spoiled. */
const GOOD_EAN = "4006381333931";
const BAD_EAN = "4006381333932";

describe("the EAN-13 checksum applies only where it means something", () => {
  it("accepts a valid EAN-13", () => {
    expect(isValidEan13(GOOD_EAN)).toBe(true);
    expect(failsEan13Checksum(GOOD_EAN)).toBe(false);
  });

  it("catches a spoiled check digit", () => {
    expect(failsEan13Checksum(BAD_EAN)).toBe(true);
  });

  it.each([
    ["an internal code", "SHELF-42"],
    ["a supplier reference", "ACME/991"],
    ["a short numeric code", "12345"],
    ["an 8-digit code", "12345678"],
    ["a 12-digit UPC-A", "012345678905"],
    ["a 14-digit code", "12345678901234"],
    ["anything empty", ""],
  ])("does not measure %s against it", (_label, code) => {
    // Only 13 pure digits are an EAN-13 claim. Judging anything else by its
    // checksum would reject codes that are correct for what they are.
    expect(failsEan13Checksum(code)).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(failsEan13Checksum(`  ${BAD_EAN}  `)).toBe(true);
    expect(failsEan13Checksum(`  ${GOOD_EAN}  `)).toBe(false);
  });
});

describe("productFormBarcodeError on CREATE", () => {
  it("requires a barcode for stocked goods", () => {
    expect(productFormBarcodeError("new", "", false)).toBe("required");
    expect(productFormBarcodeError("new", "   ", false)).toBe("required");
  });

  it("does not require one for a service", () => {
    expect(productFormBarcodeError("new", "", true)).toBeNull();
  });

  it("refuses a broken EAN-13 that it is about to write", () => {
    expect(productFormBarcodeError("new", BAD_EAN, false)).toBe("badEan13");
    expect(productFormBarcodeError("new", BAD_EAN, true)).toBe("badEan13");
  });

  it("accepts a valid EAN-13 and a non-EAN code alike", () => {
    expect(productFormBarcodeError("new", GOOD_EAN, false)).toBeNull();
    expect(productFormBarcodeError("new", "SHELF-42", false)).toBeNull();
  });
});

describe("productFormBarcodeError on EDIT — the finding itself", () => {
  it("refuses NOTHING, because an update submits no barcode", () => {
    // This is the fix. `productsRepo.save` has no `barcode` field in update
    // mode and the form shows BarcodeManager instead of an input, so the value
    // the old code judged was merely the existing primary barcode, pre-filled
    // for display.
    expect(productFormBarcodeError("edit", BAD_EAN, false)).toBeNull();
  });

  it("lets a product with a non-checksum historical code be maintained", () => {
    for (const code of [BAD_EAN, "SHELF-42", "0000000000000", "", "   "]) {
      expect(productFormBarcodeError("edit", code, false)).toBeNull();
      expect(productFormBarcodeError("edit", code, true)).toBeNull();
    }
  });

  it("does not demand a barcode for a stocked product that has none", () => {
    // Barcode-less products exist and must stay editable too.
    expect(productFormBarcodeError("edit", "", false)).toBeNull();
  });

  it("still refuses the same code on CREATE — the rule is scoped, not removed", () => {
    // The guard rail is intact where it applies. A genuinely new product
    // cannot be created with a broken EAN-13; it is only an EXISTING one that
    // is no longer re-judged.
    expect(productFormBarcodeError("new", BAD_EAN, false)).toBe("badEan13");
    expect(productFormBarcodeError("edit", BAD_EAN, false)).toBeNull();
  });
});
