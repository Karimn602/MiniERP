/**
 * The spreadsheet importer's MENU columns (WP-A5).
 *
 * Scope note: `validateImportRows` reads the database for SKU and barcode
 * duplicates, so this runs against node:sqlite with the Tauri SQL plugin
 * mocked out. See tests/README.md.
 *
 * ## Why this file exists
 *
 * The first Greaz import created all sixteen menu items correctly and left
 * every one of them with no section, no glyph and no description — so the
 * register grouped the whole menu under "Other" and somebody had to open
 * sixteen product forms by hand to fix presentation data the spreadsheet
 * already knew. The columns were not rejected; they were not read.
 *
 * Two things are pinned here, and the second matters as much as the first:
 *
 *   1. the three columns are read, validated and carried onto the row;
 *   2. a file WITHOUT them still parses, still validates and still imports —
 *      because making them required would reject every spreadsheet written
 *      against the old template, and a product with no section has always been
 *      valid (migration 013 leaves both columns nullable on purpose).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import { createSqlTestDb, resetIds, STORE_ID, VAT_STD_ID } from "../helpers/sqlDb";
import * as XLSX from "xlsx";
import {
  DESCRIPTION_MAX_CHARS,
  OPTIONAL_TEMPLATE_HEADERS,
  TEMPLATE_HEADERS,
  importableCategoryIds,
  parseSpreadsheet,
  templateRows,
  validateImportRows,
} from "../../src/lib/productImport";
import { productsRepo } from "../../src/db/repos/products";
import type { UnitOfMeasure, VatRate } from "../../src/db/types";

let db: DatabaseSync;

const VAT_RATES: VatRate[] = [
  {
    id: VAT_STD_ID,
    name: "Standard 11%",
    rateBps: 1100,
    isExempt: false,
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
  },
];

const UOMS: UnitOfMeasure[] = [
  { code: "pcs", name: "Pieces", category: "count", symbol: "pcs", isActive: true },
];

/** A row in the OLD template's shape: the ten required columns only. */
function legacyRow(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: "Double Smash Burger",
    sku: "",
    barcode: "6281234567895",
    sale_price_incl_vat: "6.00",
    vat_rate: "11%",
    stock_unit: "pcs",
    selling_unit: "pcs",
    qty_per_selling_unit: "1",
    is_service: "no",
    active: "yes",
    ...over,
  };
}

/** A row in the NEW template's shape. */
function menuRow(over: Record<string, string> = {}): Record<string, string> {
  return legacyRow({
    menu_category: "burgers",
    icon: "🍔",
    description: "Two smashed patties, cheddar, house sauce",
    ...over,
  });
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

async function validate(rows: Record<string, string>[]) {
  return validateImportRows(rows, STORE_ID, VAT_RATES, UOMS);
}

describe("the template", () => {
  it("still requires exactly the ten original columns", () => {
    // The backward-compatibility contract, stated as a test so it cannot be
    // widened by accident.
    expect(TEMPLATE_HEADERS).toEqual([
      "name",
      "sku",
      "barcode",
      "sale_price_incl_vat",
      "vat_rate",
      "stock_unit",
      "selling_unit",
      "qty_per_selling_unit",
      "is_service",
      "active",
    ]);
  });

  it("offers the three menu columns as OPTIONAL", () => {
    expect(OPTIONAL_TEMPLATE_HEADERS).toEqual(["menu_category", "icon", "description"]);
    for (const h of OPTIONAL_TEMPLATE_HEADERS) {
      expect(TEMPLATE_HEADERS).not.toContain(h);
    }
  });

  it("names the sections an import may use, excluding the fallback bucket", () => {
    // "uncategorised" is what an ABSENT section resolves to for display; it is
    // not a section you may assign, and offering it would make "deliberately
    // uncategorised" and "section named Other" two different stored values
    // meaning the same thing.
    expect(importableCategoryIds()).toEqual(["burgers", "wraps", "sides", "addons", "drinks"]);
    expect(importableCategoryIds()).not.toContain("uncategorized");
  });
});

describe("a file written against the OLD template", () => {
  it("validates with no errors and no warnings", async () => {
    const [row] = await validate([legacyRow()]);
    expect(row.status).toBe("valid");
    expect(row.errors).toEqual([]);
    expect(row.warnings).toEqual([]);
  });

  it("imports as uncategorised, with no glyph and no description", async () => {
    // Unchanged behaviour, stated explicitly: the absence of the columns is
    // not an error, and nothing is invented to fill them.
    const [row] = await validate([legacyRow()]);
    expect(row.category).toBeNull();
    expect(row.icon).toBeNull();
    expect(row.description).toBeNull();
    // And the figures it always resolved still resolve.
    expect(row.priceInclVatCents).toBe(600);
    expect(row.priceExclVatCents).toBe(541);
    expect(row.vatRate?.id).toBe(VAT_STD_ID);
  });
});

describe("the menu columns", () => {
  it("carries a section, a glyph and a description onto the row", async () => {
    const [row] = await validate([menuRow()]);
    expect(row.status).toBe("valid");
    expect(row.category).toBe("burgers");
    expect(row.icon).toBe("🍔");
    expect(row.description).toBe("Two smashed patties, cheddar, house sauce");
  });

  it("normalises a section the way the Products form does", async () => {
    // One gate for every writer (`lib/menuCategories.ts`), so " BURGERS " and
    // "burgers" cannot become two chips in the register's grid.
    const [row] = await validate([menuRow({ menu_category: "  BURGERS  " })]);
    expect(row.errors).toEqual([]);
    expect(row.category).toBe("burgers");
  });

  it("REFUSES a section the application does not know", async () => {
    // The important one. `resolveCategory` maps anything unknown onto
    // "uncategorised" for display, so an unvalidated import would silently
    // park a typo in Other — which looks exactly like having forgotten to
    // categorise the product. Refusing it names the sections instead.
    const [row] = await validate([menuRow({ menu_category: "burgerz" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toContain("burgerz");
    expect(row.errors.join(" ")).toContain("burgers");
  });

  it("treats a blank section as uncategorised rather than an error", async () => {
    const [row] = await validate([menuRow({ menu_category: "   " })]);
    expect(row.errors).toEqual([]);
    expect(row.category).toBeNull();
  });

  it("accepts a composite emoji as a glyph", async () => {
    // A flag is two code points and a profession emoji up to four; the bound
    // is code points for exactly this reason.
    for (const icon of ["🥤", "🇱🇧", "👨‍🍳"]) {
      const [row] = await validate([menuRow({ icon })]);
      expect(row.errors, icon).toEqual([]);
      expect(row.icon).toBe(icon);
    }
  });

  it("REFUSES a glyph that is really a sentence", async () => {
    const [row] = await validate([menuRow({ icon: "burger with cheese" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/icon/i);
  });

  it("REFUSES markup and formula lead-ins in a glyph", async () => {
    // A cell starting with `=` is a FORMULA to every spreadsheet that reads
    // the catalogue back out, and a glyph field is never legitimately any of
    // these characters. React escapes markup, so this is not claimed as an
    // XSS fix.
    for (const icon of ["<b>", "=1+1", "+X", "@X", "&amp"]) {
      const [row] = await validate([menuRow({ icon })]);
      expect(row.status, icon).toBe("error");
    }
  });

  it("REFUSES a bidi override in a glyph but allows a zero-width joiner", async () => {
    // One of those in a product tile reverses the rendering of the names
    // beside it, in a UI that is already bidirectional. ZWJ is how a
    // composite emoji is built and must stay legal.
    const [bad] = await validate([menuRow({ icon: "‮X" })]);
    expect(bad.status).toBe("error");

    const [ok] = await validate([menuRow({ icon: "👨‍🍳" })]);
    expect(ok.errors).toEqual([]);
  });

  it("bounds the description", async () => {
    const [ok] = await validate([menuRow({ description: "x".repeat(DESCRIPTION_MAX_CHARS) })]);
    expect(ok.errors).toEqual([]);

    const [bad] = await validate([
      menuRow({ description: "x".repeat(DESCRIPTION_MAX_CHARS + 1) }),
    ]);
    expect(bad.status).toBe("error");
    expect(bad.errors.join(" ")).toMatch(/description/i);
  });

  it("trims a description and treats a blank one as absent", async () => {
    const [row] = await validate([menuRow({ description: "  Crispy chicken  " })]);
    expect(row.description).toBe("Crispy chicken");
    const [blank] = await validate([menuRow({ description: "  " })]);
    expect(blank.description).toBeNull();
  });
});

describe("the existing import constraints are untouched", () => {
  it("still requires a VAT rate that exists", async () => {
    const [row] = await validate([menuRow({ vat_rate: "17%" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/vat rate/i);
  });

  it("still requires a barcode on a stocked product", async () => {
    const [row] = await validate([menuRow({ barcode: "" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/barcode/i);
  });

  it("still refuses a SKU repeated inside the file", async () => {
    const rows = await validate([
      menuRow({ sku: "GZ-1", barcode: "6281234567895" }),
      menuRow({ sku: "GZ-1", barcode: "6281234567888", name: "Triple" }),
    ]);
    expect(rows.every((r) => r.status === "error")).toBe(true);
    expect(rows[0].errors.join(" ")).toContain("GZ-1");
  });

  it("still refuses a barcode repeated inside the file", async () => {
    const rows = await validate([
      menuRow({ name: "A" }),
      menuRow({ name: "B" }),
    ]);
    expect(rows.every((r) => r.status === "error")).toBe(true);
    expect(rows[0].errors.join(" ")).toMatch(/barcode/i);
  });

  it("still refuses a price that is not a number", async () => {
    const [row] = await validate([menuRow({ sale_price_incl_vat: "six dollars" })]);
    expect(row.status).toBe("error");
  });

  it("still refuses an unknown unit of measure", async () => {
    const [row] = await validate([menuRow({ stock_unit: "crate" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/stock unit/i);
  });

  it("still refuses a product with no name", async () => {
    const [row] = await validate([menuRow({ name: "   " })]);
    expect(row.status).toBe("error");
  });

  it("still lets a SERVICE row skip the barcode", async () => {
    const [row] = await validate([menuRow({ is_service: "yes", barcode: "" })]);
    expect(row.errors).toEqual([]);
    expect(row.isService).toBe(true);
  });
});

describe("a whole menu in one file", () => {
  it("validates every row of a five-section restaurant menu", async () => {
    // The deliverable, as a test: a file that configures a restaurant's menu
    // without anybody opening a product form afterwards.
    const menu: Array<[string, string, string, string]> = [
      ["Double Smash Burger", "burgers", "🍔", "6281234567000"],
      ["Chicken Wrap", "wraps", "🌯", "6281234567017"],
      ["Fries", "sides", "🍟", "6281234567024"],
      ["Extra Cheddar", "addons", "🧀", "6281234567031"],
      ["Water 500ml", "drinks", "💧", "6281234567048"],
    ];
    const rows = await validate(
      menu.map(([name, menu_category, icon, barcode]) =>
        menuRow({ name, menu_category, icon, barcode, sku: name }),
      ),
    );

    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "valid")).toBe(true);
    expect(rows.map((r) => r.category)).toEqual([
      "burgers",
      "wraps",
      "sides",
      "addons",
      "drinks",
    ]);
    expect(rows.every((r) => r.icon !== null)).toBe(true);
    expect(rows.every((r) => r.description !== null)).toBe(true);
  });

  it("refuses only the offending row, leaving the rest importable", async () => {
    const rows = await validate([
      menuRow({ name: "Good", sku: "G1", barcode: "6281234567000" }),
      menuRow({ name: "Bad", sku: "B1", barcode: "6281234567017", menu_category: "pizzas" }),
      menuRow({ name: "Also good", sku: "G2", barcode: "6281234567024" }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["valid", "error", "valid"]);
  });
});

describe("the template we actually ship", () => {
  /** The downloaded workbook, round-tripped back through the importer. */
  async function parseTheTemplate() {
    const ws = XLSX.utils.aoa_to_sheet(templateRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const file = new File([buf], "product_import_template.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    return parseSpreadsheet(file);
  }

  it("parses through the importer's own reader", async () => {
    // Not an assumption: the file the owner downloads is built here, written
    // as xlsx, and read back by the same function that reads a user's file.
    const rows = await parseTheTemplate();
    expect(rows).toHaveLength(2);
    for (const h of [...TEMPLATE_HEADERS, ...OPTIONAL_TEMPLATE_HEADERS]) {
      expect(Object.keys(rows[0]), h).toContain(h);
    }
  });

  it("validates CLEAN — no errors and no warnings on either example", async () => {
    // The defect this closes: the shipped example carried an EAN-13 whose
    // check digit was wrong, so a shop that downloaded the template and
    // imported it unchanged was greeted by a checksum warning on the row we
    // gave them.
    const rows = await parseTheTemplate();
    const validated = await validateImportRows(rows, STORE_ID, VAT_RATES, UOMS);
    for (const r of validated) {
      expect(r.errors, `row ${r.rowNum} errors`).toEqual([]);
      expect(r.warnings, `row ${r.rowNum} warnings`).toEqual([]);
      expect(r.status).toBe("valid");
    }
  });

  it("shows the menu columns filled in on one row and blank on the other", async () => {
    const validated = await validateImportRows(
      await parseTheTemplate(),
      STORE_ID,
      VAT_RATES,
      UOMS,
    );
    const [menu, plain] = validated;

    expect(menu.category).toBe("burgers");
    expect(menu.icon).toBeTruthy();
    expect(menu.description).toBeTruthy();

    // The backward-compatible shape, in the same file: the columns are there
    // and empty, and that is valid.
    expect(plain.category).toBeNull();
    expect(plain.icon).toBeNull();
    expect(plain.description).toBeNull();
    expect(plain.status).toBe("valid");
  });

  it("still parses when the three optional columns are deleted entirely", async () => {
    // A shop on the OLD template, or one that deleted the columns it did not
    // want. The importer must not ask for them.
    const [headers, menuExample] = templateRows();
    const keep = headers
      .map((h, i) => [h, i] as const)
      .filter(([h]) => !OPTIONAL_TEMPLATE_HEADERS.includes(h));
    const ws = XLSX.utils.aoa_to_sheet([
      keep.map(([h]) => h),
      keep.map(([, i]) => menuExample[i]),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const file = new File([buf], "old.xlsx");

    const validated = await validateImportRows(
      await parseSpreadsheet(file),
      STORE_ID,
      VAT_RATES,
      UOMS,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0].status).toBe("valid");
    expect(validated[0].category).toBeNull();
  });

  it("REFUSES a file missing a REQUIRED column, naming it", async () => {
    const [headers, menuExample] = templateRows();
    const drop = headers.indexOf("vat_rate");
    const ws = XLSX.utils.aoa_to_sheet([
      headers.filter((_, i) => i !== drop),
      menuExample.filter((_, i) => i !== drop),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const file = new File([XLSX.write(wb, { type: "array", bookType: "xlsx" })], "bad.xlsx");

    await expect(parseSpreadsheet(file)).rejects.toThrow(/vat_rate/);
  });
});

// ===========================================================================
// Codex WP-A findings 4 and 5 — the importer validates the WHOLE cell, and
// the row's own `active` flag is what gets persisted.
// ===========================================================================

describe("every cell is validated in full, never by numeric prefix (GZ-A-05)", () => {
  // `parseFloat` and `parseInt` read a numeric PREFIX and stop. That is the
  // defect: a mistyped cell did not fail the import, it imported whatever the
  // typo happened to start with — and the preview showed the result as a
  // valid row, so there was nothing to notice.

  it('refuses "2abc" as a price instead of importing $2.00', async () => {
    const [row] = await validate([legacyRow({ sale_price_incl_vat: "2abc" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/sale price/i);
    expect(row.errors.join(" ")).toContain("2abc");
  });

  it('refuses "12abc" as a price instead of importing $12.00', async () => {
    const [row] = await validate([legacyRow({ sale_price_incl_vat: "12abc" })]);
    expect(row.status).toBe("error");
  });

  it("refuses a price with more than two decimal places rather than rounding it", async () => {
    // Money here is integer cents. Turning 2.555 into 2.56 on an import is
    // the shop's margin being decided by a rounding rule nobody saw.
    const [row] = await validate([legacyRow({ sale_price_incl_vat: "2.555" })]);
    expect(row.status).toBe("error");
  });

  it("refuses a negative price", async () => {
    const [row] = await validate([legacyRow({ sale_price_incl_vat: "-3.00" })]);
    expect(row.status).toBe("error");
  });

  it("refuses a price that is only punctuation or spaces", async () => {
    for (const bad of ["", " ", ".", "-", "$", "1,2,3", "1.2.3", "3.50 each", "1e3"]) {
      const [row] = await validate([legacyRow({ sale_price_incl_vat: bad })]);
      expect(row.status, `price ${JSON.stringify(bad)} must be refused`).toBe("error");
    }
  });

  it("still accepts the money the shop actually types, including 2.50", async () => {
    for (const [text, cents] of [
      ["2.50", 250],
      ["2.5", 250],
      ["2", 200],
      ["0", 0],
      ["0.05", 5],
      ["12.34", 1234],
      ["$6.00", 600],
      ["1,250.00", 125000],
      [" 6.00 ", 600],
    ] as [string, number][]) {
      const [row] = await validate([legacyRow({ sale_price_incl_vat: text })]);
      expect(row.errors, `price ${text} must be accepted`).toEqual([]);
      expect(row.priceInclVatCents).toBe(cents);
    }
  });

  it("refuses a fractional quantity in the whole-number conversion field", async () => {
    // `parseInt("2.5")` is 2: the conversion factor a UoM row exists to state
    // exactly was silently truncated and imported as fact.
    const [row] = await validate([
      legacyRow({ stock_unit: "pcs", selling_unit: "box", qty_per_selling_unit: "2.5" }),
    ]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/qty_per_selling_unit/);
  });

  it('refuses "12abc" and a negative or zero quantity', async () => {
    for (const bad of ["12abc", "-6", "0", "", " ", "1/2"]) {
      const [row] = await validate([
        legacyRow({ stock_unit: "pcs", selling_unit: "box", qty_per_selling_unit: bad }),
      ]);
      expect(row.status, `qty ${JSON.stringify(bad)} must be refused`).toBe("error");
    }
  });

  it("refuses an unknown boolean token rather than guessing", async () => {
    for (const bad of ["maybe", "inactive", "Y E S", "2", "-1", "true-ish", "si"]) {
      const [active] = await validate([legacyRow({ active: bad })]);
      expect(active.status, `active ${JSON.stringify(bad)} must be refused`).toBe("error");
      expect(active.errors.join(" ")).toMatch(/yes\/no/i);

      const [service] = await validate([legacyRow({ is_service: bad })]);
      expect(service.status, `is_service ${JSON.stringify(bad)} must be refused`).toBe(
        "error",
      );
    }
  });

  it("accepts exactly the documented boolean tokens, in either case", async () => {
    for (const yes of ["yes", "YES", "true", "True", "1", "y", "Y", " yes "]) {
      const [row] = await validate([legacyRow({ active: yes })]);
      expect(row.errors, `active ${JSON.stringify(yes)}`).toEqual([]);
      expect(row.isActive).toBe(true);
    }
    for (const no of ["no", "NO", "false", "False", "0", "n", "N", " no "]) {
      const [row] = await validate([legacyRow({ active: no })]);
      expect(row.errors, `active ${JSON.stringify(no)}`).toEqual([]);
      expect(row.isActive).toBe(false);
    }
  });

  it("keeps the blank-cell defaults, which is the backward-compatible half", async () => {
    // An omitted or empty optional cell must keep behaving as it always has:
    // active, and goods rather than a service.
    const [row] = await validate([legacyRow({ active: "", is_service: "" })]);
    expect(row.errors).toEqual([]);
    expect(row.isActive).toBe(true);
    expect(row.isService).toBe(false);
  });

  it("refuses a VAT cell that merely STARTS with a known rate", async () => {
    const [row] = await validate([legacyRow({ vat_rate: "11abc" })]);
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toMatch(/vat/i);
  });

  it("still matches a VAT rate by name and by percentage", async () => {
    for (const good of ["11%", "11", "Standard 11%", "standard 11%", "11.00"]) {
      const [row] = await validate([legacyRow({ vat_rate: good })]);
      expect(row.errors, `vat ${good}`).toEqual([]);
      expect(row.vatRate?.id).toBe(VAT_STD_ID);
    }
  });

  it("a file written against the OLD template still imports unchanged", async () => {
    // The whole point of tightening the parsers is that nothing correct
    // breaks. This is the legacy shape, fully valid, start to finish.
    const rows = await validate([
      legacyRow(),
      legacyRow({ name: "Fries", barcode: "6281234567901", sale_price_incl_vat: "2.50" }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["valid", "valid"]);
    expect(rows[1].priceInclVatCents).toBe(250);
  });

  it("validates a CSV file by the same rules as an XLSX one", async () => {
    // Both paths land in `parseSpreadsheet`, so this proves the file format
    // does not get its own, looser, reading of a cell.
    const header = TEMPLATE_HEADERS.join(",");
    const good = "Fries,,6281234567901,2.50,11%,pcs,pcs,1,no,yes";
    const bad = "Wings,,6281234567918,2abc,11%,pcs,pcs,1,no,maybe";
    const csv = [header, good, bad].join("\n");
    const file = new File([csv], "menu.csv", { type: "text/csv" });

    const parsed = await parseSpreadsheet(file);
    expect(parsed).toHaveLength(2);
    const rows = await validate(parsed);
    expect(rows[0].status).toBe("valid");
    expect(rows[0].priceInclVatCents).toBe(250);
    expect(rows[1].status).toBe("error");
    expect(rows[1].errors.join(" ")).toMatch(/2abc/);
    expect(rows[1].errors.join(" ")).toMatch(/yes\/no/i);
  });
});

describe("a row's active flag survives all the way to the database (GZ-A-04)", () => {
  // LAYER 1 — what the file says, parsed.
  it("parses active=no as inactive", async () => {
    const [row] = await validate([legacyRow({ active: "no" })]);
    expect(row.status).toBe("valid");
    expect(row.isActive).toBe(false);
  });

  it("parses is_service=yes as a service, which needs no barcode", async () => {
    const [row] = await validate([legacyRow({ is_service: "yes", barcode: "" })]);
    expect(row.status).toBe("valid");
    expect(row.isService).toBe(true);
  });

  // LAYER 2 (the preview) is pinned in tests/unit/productImportDialog.test.tsx,
  // which renders the real dialog and reads the call it makes; LAYER 3 (the
  // persisted row) is pinned in src-tauri/src/tests/catalog.rs, because only
  // the Rust command writes it. Nothing here infers persistence from a
  // frontend value.
});

// ===========================================================================
// Codex round 2 — every refusal has its OWN reason, and an invalid check
// digit is a refusal (GZ-A-07), plus retired-barcode collisions (GZ-A-08)
// ===========================================================================

describe("a row that is not imported says WHY, accurately (GZ-A-07)", () => {
  /** The codes on a row, deduplicated, for terse assertions. */
  function codes(row: { issues: { code: string }[] }): string[] {
    return [...new Set(row.issues.map((i) => i.code))].sort();
  }

  it("refuses a 13-digit barcode whose check digit does not compute", async () => {
    // THE DEFECT. This was a WARNING, and a warning row is not imported — so
    // the product was silently not created and the summary said it had been
    // "skipped because its SKU already exists", which had not happened.
    const [row] = await validate([legacyRow({ barcode: "5281234567891" })]);
    expect(row.status).toBe("error");
    expect(codes(row)).toEqual(["invalid_barcode_checksum"]);
    expect(row.errors.join(" ")).toMatch(/check digit/i);
    expect(row.warnings).toEqual([]);
    expect(row.errors.join(" ")).not.toMatch(/sku/i);
  });

  it("accepts the same barcode once its check digit is corrected", async () => {
    const [row] = await validate([legacyRow({ barcode: "5281234567896" })]);
    expect(row.status).toBe("valid");
    expect(row.issues).toEqual([]);
  });

  it("gives an existing SKU its own code, as a SKIP rather than a refusal", async () => {
    db.exec(
      `INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                             price_excl_vat_cents, price_incl_vat_cents)
       VALUES ('p-existing', '${STORE_ID}', 'GZ-EXISTS', 'Already here', '${VAT_STD_ID}',
               'inclusive', 100, 111)`,
    );
    const [row] = await validate([legacyRow({ sku: "GZ-EXISTS" })]);
    expect(row.status).toBe("warning");
    expect(codes(row)).toEqual(["sku_exists"]);
    expect(row.issues[0].skip).toBe(true);
  });

  it("distinguishes a duplicate inside the file from one in the database", async () => {
    const rows = await validate([
      legacyRow({ sku: "GZ-TWICE", barcode: "5281234567896" }),
      legacyRow({ sku: "GZ-TWICE", barcode: "5281234567902" }),
    ]);
    expect(codes(rows[0])).toContain("duplicate_sku_in_file");
    expect(codes(rows[1])).toContain("duplicate_sku_in_file");

    const bar = await validate([
      legacyRow({ sku: "A", barcode: "5281234567896" }),
      legacyRow({ sku: "B", barcode: "5281234567896" }),
    ]);
    expect(codes(bar[0])).toContain("duplicate_barcode_in_file");
  });

  it("codes other malformed data separately again", async () => {
    const [row] = await validate([legacyRow({ sale_price_incl_vat: "2abc" })]);
    expect(codes(row)).toEqual(["malformed_row"]);
  });

  it("counts a mixed file correctly: valid, rejected and skipped are three things", async () => {
    db.exec(
      `INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                             price_excl_vat_cents, price_incl_vat_cents)
       VALUES ('p-dup', '${STORE_ID}', 'GZ-DUP', 'Already here', '${VAT_STD_ID}',
               'inclusive', 100, 111)`,
    );
    const rows = await validate([
      legacyRow({ sku: "GZ-GOOD", barcode: "5281234567896" }), // valid
      legacyRow({ sku: "GZ-DUP", barcode: "5281234567902" }), // skipped
      legacyRow({ sku: "GZ-BAD", barcode: "5281234567891" }), // rejected: checksum
      legacyRow({ sku: "GZ-UGLY", barcode: "5281234567919", active: "maybe" }), // rejected
    ]);
    expect(rows.map((r) => r.status)).toEqual(["valid", "warning", "error", "error"]);
    expect(rows.filter((r) => r.status === "valid")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "warning")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "error")).toHaveLength(2);
    // And no rejected row is attributed to an existing SKU.
    for (const r of rows.filter((x) => x.status === "error")) {
      expect(codes(r)).not.toContain("sku_exists");
    }
  });

  it("applies the same rules to a CSV file as to an XLSX one", async () => {
    const header = TEMPLATE_HEADERS.join(",");
    const csv = [
      header,
      "Good,GZ-CSV-1,5281234567896,2.50,11%,pcs,pcs,1,no,yes",
      "Bad,GZ-CSV-2,5281234567891,2.50,11%,pcs,pcs,1,no,yes",
    ].join("\n");
    const parsedCsv = await validate(
      await parseSpreadsheet(new File([csv], "menu.csv", { type: "text/csv" })),
    );
    expect(parsedCsv.map((r) => r.status)).toEqual(["valid", "error"]);
    expect(codes(parsedCsv[1])).toEqual(["invalid_barcode_checksum"]);

    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS,
      ["Good", "GZ-X-1", "5281234567896", "2.50", "11%", "pcs", "pcs", "1", "no", "yes"],
      ["Bad", "GZ-X-2", "5281234567891", "2.50", "11%", "pcs", "pcs", "1", "no", "yes"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const file = new File([XLSX.write(wb, { type: "array", bookType: "xlsx" })], "menu.xlsx");
    const parsedXlsx = await validate(await parseSpreadsheet(file));
    expect(parsedXlsx.map((r) => r.status)).toEqual(["valid", "error"]);
    expect(codes(parsedXlsx[1])).toEqual(["invalid_barcode_checksum"]);
  });
});

describe("a barcode held by a RETIRED product is diagnosable (GZ-A-08)", () => {
  function seedOwner(isActive: number, barcode = "5281234567896") {
    db.exec(
      `INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                             price_excl_vat_cents, price_incl_vat_cents, is_active)
       VALUES ('p-owner', '${STORE_ID}', 'GZ-OWNER', 'Seasonal Shake', '${VAT_STD_ID}',
               'inclusive', 100, 111, ${isActive})`,
    );
    db.exec(
      `INSERT INTO product_barcodes (id, store_id, product_id, barcode, lookup_value,
                                     barcode_type, is_primary, is_active)
       VALUES ('bc-owner', '${STORE_ID}', 'p-owner', '${barcode}', '${barcode}',
               'EAN13', 1, 1)`,
    );
  }

  it("names the ACTIVE product that already uses the barcode", async () => {
    seedOwner(1);
    const [row] = await validate([legacyRow({ sku: "GZ-NEW", barcode: "5281234567896" })]);
    expect(row.status).toBe("error");
    expect(row.issues.map((i) => i.code)).toContain("barcode_taken_by_active_product");
    expect(row.errors.join(" ")).toContain("Seasonal Shake");
    expect(row.errors.join(" ")).toContain("GZ-OWNER");
  });

  it("says the owner is INACTIVE, and what to do about it", async () => {
    // The case nobody could diagnose: the uniqueness constraint is on the
    // barcode row, so a retired product still reserves the value — and the
    // Products page did not list retired products at all.
    seedOwner(0);
    const [row] = await validate([legacyRow({ sku: "GZ-NEW", barcode: "5281234567896" })]);
    expect(row.status).toBe("error");
    expect(row.issues.map((i) => i.code)).toContain("barcode_taken_by_inactive_product");
    const msg = row.errors.join(" ");
    expect(msg).toContain("Seasonal Shake");
    expect(msg).toMatch(/inactive/i);
    expect(msg).toMatch(/show inactive/i);
    // It must not promise anything it will not do.
    expect(msg).toMatch(/will not move a barcode/i);
  });

  it("imports nothing and reactivates nothing by itself", async () => {
    seedOwner(0);
    await validate([legacyRow({ sku: "GZ-NEW", barcode: "5281234567896" })]);
    // Validation is read-only: the retired product is still retired, its
    // barcode still belongs to it, and no row was created.
    const owner = db
      .prepare(`SELECT is_active FROM products WHERE id = 'p-owner'`)
      .get() as { is_active: number };
    expect(owner.is_active).toBe(0);
    const bc = db
      .prepare(`SELECT product_id FROM product_barcodes WHERE id = 'bc-owner'`)
      .get() as { product_id: string };
    expect(bc.product_id).toBe("p-owner");
    const created = db
      .prepare(`SELECT COUNT(*) AS n FROM products WHERE sku = 'GZ-NEW'`)
      .get() as { n: number };
    expect(created.n).toBe(0);
  });


  it("reports a checksum fault AND a collision in the same pass", async () => {
    // The gate used to stop at the first fault, so the operator corrected the
    // digits, re-imported, and only then met the clash.
    db.exec(
      `INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                             price_excl_vat_cents, price_incl_vat_cents, is_active)
       VALUES ('p-retired', '${STORE_ID}', 'GZ-RETIRED', 'Old Shake', '${VAT_STD_ID}',
               'inclusive', 100, 111, 0)`,
    );
    db.exec(
      `INSERT INTO product_barcodes (id, store_id, product_id, barcode, lookup_value,
                                     barcode_type, is_primary, is_active)
       VALUES ('bc-retired', '${STORE_ID}', 'p-retired', '5281234567891', '5281234567891',
               'EAN13', 1, 1)`,
    );

    const [row] = await validate([legacyRow({ sku: "GZ-NEW", barcode: "5281234567891" })]);
    const found = row.issues.map((i) => i.code).sort();
    expect(found).toEqual([
      "barcode_taken_by_inactive_product",
      "invalid_barcode_checksum",
    ]);
    expect(row.status).toBe("error");
  });

  it("lets the operator find the retired product once inactive rows are shown", async () => {
    // The actionable path the message points at: `listEnriched` without the
    // flag hides it (that is the menu), and with the flag the Products page
    // can open it and tick Active through the ordinary save.
    seedOwner(0);
    db.exec(
      `INSERT INTO product_uoms (id, store_id, product_id, uom_code, factor_num, factor_den,
                                 is_base, is_default_sale_uom, is_default_purchase_uom, is_active)
       VALUES ('uom-owner', '${STORE_ID}', 'p-owner', 'pcs', 1, 1, 1, 1, 1, 1)`,
    );

    const visible = await productsRepo.listEnriched({ storeId: STORE_ID });
    expect(visible.map((p) => p.id)).not.toContain("p-owner");

    const withRetired = await productsRepo.listEnriched({
      storeId: STORE_ID,
      includeInactive: true,
    });
    expect(withRetired.map((p) => p.id)).toContain("p-owner");
    expect(withRetired.find((p) => p.id === "p-owner")?.isActive).toBe(false);
  });
});
