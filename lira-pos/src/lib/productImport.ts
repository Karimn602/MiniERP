import * as XLSX from "xlsx";
import { query } from "../db/client";
import { normalizeBarcode, isValidEan13 } from "./barcode";
import { stripVat } from "./vat";
import { gcd } from "./uom";
import {
  ICON_MAX_CODE_POINTS,
  MENU_CATEGORIES,
  UNCATEGORIZED_ID,
  isKnownCategory,
  isSafeIcon,
  normalizeCategoryId,
} from "./menuCategories";
import type { VatRate, UnitOfMeasure } from "../db/types";
import type { Factor } from "./uom";

// ─── Public types ────────────────────────────────────────────────────────────

export type RowStatus = "valid" | "warning" | "error";

/**
 * WHY A ROW IS NOT BEING IMPORTED, as a code rather than only a sentence.
 *
 * The preview used to carry two bags of strings and the summary counted the
 * bags: every WARNING row was reported as "will be skipped (SKU exists)".
 * That was wrong in both directions at once. A barcode whose EAN-13 check
 * digit does not compute was only a warning, so a product the operator
 * believed they had imported was silently not created — and the reason given
 * for not creating it named a SKU clash that had not happened. An operator
 * cannot fix what the screen misdescribes.
 *
 * So each issue now carries a code. The sentence is still what the operator
 * reads; the code is what the summary counts and what the tests assert on.
 */
export type ImportIssueCode =
  /** The 13-digit barcode's check digit does not compute. */
  | "invalid_barcode_checksum"
  /** The same SKU appears twice in the uploaded file. */
  | "duplicate_sku_in_file"
  /** The same barcode appears twice in the uploaded file. */
  | "duplicate_barcode_in_file"
  /** A product with this SKU is already in the database — row skipped. */
  | "sku_exists"
  /** The barcode belongs to another product that is currently SELLABLE. */
  | "barcode_taken_by_active_product"
  /** The barcode belongs to a product that exists but is INACTIVE. */
  | "barcode_taken_by_inactive_product"
  /** Anything else wrong with the row's own data. */
  | "malformed_row";

export interface ImportIssue {
  code: ImportIssueCode;
  /** The operator-facing sentence. */
  message: string;
  /** True when the row is dropped without being an error (SKU already there). */
  skip?: boolean;
}

/** Is this issue a refusal rather than a deliberate skip? */
export function isRejection(issue: ImportIssue): boolean {
  return issue.skip !== true;
}

export interface ImportRowValidated {
  rowNum: number;

  // Raw cell values (always populated)
  rawName: string;
  rawSku: string;
  rawBarcode: string;
  rawPrice: string;
  rawVatRate: string;
  rawStockUnit: string;
  rawSellingUnit: string;
  rawQtyPerSellingUnit: string;
  rawIsService: string;
  rawActive: string;
  // Optional columns (WP-A5). Always present on the object, blank when the
  // spreadsheet omits the column — so the preview table never has to ask
  // whether a field exists.
  rawCategory: string;
  rawIcon: string;
  rawDescription: string;

  // Resolved values (populated when valid)
  name: string;
  sku: string | null;
  barcode: string | null;
  priceInclVatCents: number;
  priceExclVatCents: number;
  vatRate: VatRate | null;
  stockUom: UnitOfMeasure | null;
  saleUom: UnitOfMeasure | null;
  saleFactor: Factor;
  isService: boolean;
  isActive: boolean;
  /** Normalised menu-section id, or null for uncategorised (WP-A5). */
  category: string | null;
  /** The tile glyph, or null to fall back to the section's own (WP-A5). */
  icon: string | null;
  /** Free text for the product card, or null (WP-A5). */
  description: string | null;

  status: RowStatus;
  /**
   * Every reason this row is not a clean import, coded.
   *
   * `errors` and `warnings` are derived from it and kept so the preview table
   * and the existing tests read unchanged.
   */
  issues: ImportIssue[];
  errors: string[];
  warnings: string[];
}

/**
 * The columns a file MUST have. Unchanged since the first importer, and that
 * is the whole backward-compatibility contract: a spreadsheet written against
 * the old template still parses, still validates and still imports (WP-A5).
 */
export const TEMPLATE_HEADERS = [
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
];

/**
 * The columns a file MAY have (WP-A5).
 *
 * These are what made the difference between importing a catalogue and
 * configuring a MENU. The first Greaz import created all sixteen items
 * correctly and left every one of them with no section, no glyph and no
 * description — so the register grouped the entire menu under "Other" and
 * somebody had to open sixteen product forms by hand to fix presentation data
 * the spreadsheet already knew.
 *
 * They are OPTIONAL, not required, and that is deliberate: making them
 * mandatory would reject every file written against the old template, and a
 * product with no section has always been valid (migration 013 leaves both
 * columns nullable precisely so a shop mid-service is never blocked on
 * categorising its catalogue).
 */
export const OPTIONAL_TEMPLATE_HEADERS = ["menu_category", "icon", "description"];

/** The longest description a row may carry. */
export const DESCRIPTION_MAX_CHARS = 500;

/** The menu-section ids an import may name, in menu order. */
export function importableCategoryIds(): string[] {
  return MENU_CATEGORIES.filter((c) => c.id !== UNCATEGORIZED_ID).map((c) => c.id);
}

// ─── Template download ────────────────────────────────────────────────────────

/**
 * The exact grid the downloaded template contains: header row, then examples.
 *
 * Exported so the SHIPPED TEMPLATE can be tested rather than assumed. Its
 * example row carried a barcode whose EAN-13 check digit was wrong, so
 * re-importing the template unchanged raised a checksum warning on its own
 * example — the kind of defect that only ever shows up when a test parses the
 * thing the user actually downloads.
 *
 * Two example rows, because the point of the optional columns is that a whole
 * restaurant menu can be configured from the file, and one example showing
 * them filled in says that better than a paragraph does. The second leaves
 * them blank, which is the backward-compatible shape.
 */
export function templateRows(): string[][] {
  const headers = [...TEMPLATE_HEADERS, ...OPTIONAL_TEMPLATE_HEADERS];
  const menuExample = [
    "Double Smash Burger",
    "",
    // A VALID EAN-13. The original template's example carried
    // 6281234567894, whose check digit is wrong, so re-importing the template
    // unchanged raised a checksum warning on its own example row.
    "6281234567895",
    "6.00",
    "11%",
    "pcs",
    "pcs",
    "1",
    "no",
    "yes",
    "burgers",
    "🍔",
    "Two smashed patties, cheddar, house sauce",
  ];
  const plainExample = [
    "Coca-Cola 330ml",
    "",
    "6281234567888",
    "2.50",
    "11%",
    "pcs",
    "pcs",
    "1",
    "no",
    "yes",
    "",
    "",
    "",
  ];

  return [headers, menuExample, plainExample];
}

export function downloadTemplate(): void {
  const ws = XLSX.utils.aoa_to_sheet(templateRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  XLSX.writeFile(wb, "product_import_template.xlsx");
}

// ─── Spreadsheet parsing ──────────────────────────────────────────────────────

export async function parseSpreadsheet(
  file: File,
): Promise<Record<string, string>[]> {
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: "array", raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("The file has no sheets.");

  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: "",
  });

  if (aoa.length < 2) throw new Error("The file has no data rows.");

  const headerRow = (aoa[0] as string[]).map((h) =>
    String(h ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_"),
  );

  // Only the REQUIRED headers are checked. An old file without the three
  // optional columns is valid, and a file carrying extra columns we do not
  // know is left alone rather than refused.
  const missing = TEMPLATE_HEADERS.filter((h) => !headerRow.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  }

  const rows: Record<string, string>[] = [];

  for (let i = 1; i < aoa.length; i++) {
    const cells = aoa[i] as string[];
    const row: Record<string, string> = {};
    for (let j = 0; j < headerRow.length; j++) {
      row[headerRow[j]] = String(cells[j] ?? "").trim();
    }
    // Skip completely empty rows. Checked across the optional columns too: a
    // row with only a description is still a row somebody typed, and
    // discarding it silently would hide a mistake.
    const hasContent = [...TEMPLATE_HEADERS, ...OPTIONAL_TEMPLATE_HEADERS].some(
      (h) => row[h] !== undefined && row[h] !== "",
    );
    if (hasContent) rows.push(row);
  }

  if (rows.length === 0) throw new Error("The file has no data rows.");
  return rows;
}

// ─── Matching helpers ─────────────────────────────────────────────────────────

function matchVatRate(input: string, vatRates: VatRate[]): VatRate | null {
  const s = input.trim();
  if (!s) return null;

  const byName = vatRates.find(
    (v) => v.name.toLowerCase() === s.toLowerCase(),
  );
  if (byName) return byName;

  // A percentage, matched on the WHOLE cell. `parseFloat("11abc")` is 11, so
  // the prefix reading that mispriced products would also have matched a
  // malformed VAT cell onto the 11% rate and posted tax against it.
  const pctStr = s.replace(/%$/, "").trim();
  if (/^\d+(\.\d+)?$/.test(pctStr)) {
    const bps = Math.round(Number(pctStr) * 100);
    const byBps = vatRates.find((v) => v.rateBps === bps);
    if (byBps) return byBps;
  }

  return null;
}

function matchUom(input: string, uoms: UnitOfMeasure[]): UnitOfMeasure | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  return (
    uoms.find(
      (u) => u.code.toLowerCase() === s || u.name.toLowerCase() === s,
    ) ?? null
  );
}

/**
 * The ONLY tokens that mean yes and no in a spreadsheet cell.
 *
 * Stated as data, and exported, because "what counts as yes" is part of the
 * file format the shop writes against — it belongs in the template help and
 * in the error message, not buried in a conditional.
 */
export const TRUE_TOKENS = ["yes", "true", "1", "y"] as const;
export const FALSE_TOKENS = ["no", "false", "0", "n"] as const;

/**
 * Parse a boolean cell. `null` means the cell holds something that is neither.
 *
 * It used to fall back to the default for ANY unrecognised text, which is how
 * `active: "maybe"`, `active: "inactive"` and a stray `active: "0 "` in a
 * merged cell all became an ACTIVE, sellable product with nothing said. A
 * blank cell is still the default — that is the backward-compatible part of
 * the contract, and an omitted optional column must keep working — but a cell
 * somebody typed into and got wrong is now refused by name.
 */
function parseBoolStrict(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if ((TRUE_TOKENS as readonly string[]).includes(s)) return true;
  if ((FALSE_TOKENS as readonly string[]).includes(s)) return false;
  return null;
}

/** The accepted tokens, for an error message that tells the operator the rule. */
export function booleanTokenHelp(): string {
  return `${TRUE_TOKENS.join(", ")} (yes) or ${FALSE_TOKENS.join(", ")} (no)`;
}

/**
 * Parse a money cell into cents, or `null` when the cell is not an amount.
 *
 * FULL-STRING, and that is the correction. `parseFloat` reads a NUMERIC
 * PREFIX and stops: "2abc" came back as 2, "12abc" as 12, "3.50 each" as 3.50
 * and "1,2,3" as 1 — so a typo did not fail the import, it priced the product
 * at whatever the typo started with, and the preview showed that price as a
 * valid row. The shape accepted here is the application's own money format,
 * the one `parseUsdInput` and `parseFeeCents` already use: digits, optionally
 * a decimal point and at most two places. A leading `$` and thousands commas
 * are still stripped first, because a spreadsheet writes them and a human
 * reading the cell would call it a price.
 *
 * Three or more decimal places are refused rather than rounded: money here is
 * integer cents, and silently turning 2.555 into 2.56 on an import is the
 * shop's margin being decided by a rounding rule nobody saw.
 */
function parsePrice(input: string): number | null {
  const raw = input.trim().replace(/^\$/, "").trim();
  if (!raw) return null;
  // Thousands separators are accepted only where a spreadsheet would put
  // them. Stripping every comma first would turn "1,2,3" — which is not a
  // number in any locale this ships to — into 123.
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw);
  const s = grouped ? raw.replace(/,/g, "") : raw;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Parse a whole-number quantity cell, or `null`.
 *
 * `parseInt` has the same prefix problem as `parseFloat` and one worse case
 * of its own: it truncates. "2.5" became 2 and "12abc" became 12, so a
 * fractional conversion factor — the thing a UoM row exists to state exactly
 * — was silently halved into a whole number and imported as fact.
 */
function parseWholeNumber(input: string): number | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// ─── DB duplicate checks ──────────────────────────────────────────────────────

async function skuExistsInDb(storeId: string, sku: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND sku = ?`,
    [storeId, sku],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** Who owns this barcode already, and is that product sellable? */
export interface BarcodeOwner {
  productId: string;
  productName: string;
  productSku: string | null;
  productIsActive: boolean;
}

/**
 * Find the product a barcode is already attached to, or null.
 *
 * It returns the OWNER rather than a boolean because the two cases need
 * different sentences and different advice. `UNIQUE (store_id, barcode)`
 * (migration 002) is on the barcode row and takes no notice of whether the
 * product is active, so a value held by a retired product is still reserved —
 * which is exactly the case the operator cannot diagnose from "that barcode
 * already exists". The row is still refused either way: nothing here moves a
 * barcode between products, reactivates anything, or deletes a barcode row
 * that history may reference through its product.
 */
async function findBarcodeOwner(
  storeId: string,
  barcode: string,
): Promise<BarcodeOwner | null> {
  const lookup = normalizeBarcode(barcode);
  const rows = await query<{
    product_id: string;
    name: string;
    sku: string | null;
    is_active: number;
  }>(
    `SELECT p.id AS product_id, p.name AS name, p.sku AS sku, p.is_active AS is_active
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
      WHERE pb.store_id = ? AND pb.lookup_value = ? AND pb.is_active = 1
      LIMIT 1`,
    [storeId, lookup],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    productId: row.product_id,
    productName: row.name,
    productSku: row.sku,
    productIsActive: row.is_active === 1,
  };
}

// ─── Row validation ───────────────────────────────────────────────────────────

export async function validateImportRows(
  rawRows: Record<string, string>[],
  storeId: string,
  vatRates: VatRate[],
  uoms: UnitOfMeasure[],
): Promise<ImportRowValidated[]> {
  // Build in-file duplicate sets for fast lookup
  const seenSkus = new Map<string, number>(); // sku → first rowNum
  const seenBarcodes = new Map<string, number>(); // barcode → first rowNum

  // First pass: collect non-empty skus and barcodes to find in-file duplicates
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const sku = row["sku"]?.trim();
    const barcode = row["barcode"]?.trim();
    const rowNum = i + 2; // 1-based, header is row 1

    if (sku) {
      if (!seenSkus.has(sku)) seenSkus.set(sku, rowNum);
    }
    if (barcode) {
      const normalized = normalizeBarcode(barcode);
      if (!seenBarcodes.has(normalized)) seenBarcodes.set(normalized, rowNum);
    }
  }

  const duplicateSkusInFile = new Set<string>();
  const duplicateBarcodesInFile = new Set<string>();

  // Second pass to find actual duplicates (seen more than once)
  const skuCount = new Map<string, number>();
  const barcodeCount = new Map<string, number>();
  for (const row of rawRows) {
    const sku = row["sku"]?.trim();
    const barcode = row["barcode"]?.trim();
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
    if (barcode) {
      const normalized = normalizeBarcode(barcode);
      barcodeCount.set(normalized, (barcodeCount.get(normalized) ?? 0) + 1);
    }
  }
  for (const [sku, count] of skuCount) {
    if (count > 1) duplicateSkusInFile.add(sku);
  }
  for (const [barcode, count] of barcodeCount) {
    if (count > 1) duplicateBarcodesInFile.add(barcode);
  }

  const results: ImportRowValidated[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rowNum = i + 2;
    const issues: ImportIssue[] = [];
    /** Record a refusal. */
    const reject = (code: ImportIssueCode, message: string) =>
      issues.push({ code, message });
    /** Record a deliberate skip: the row is fine, it is just already there. */
    const skip = (code: ImportIssueCode, message: string) =>
      issues.push({ code, message, skip: true });
    const errors = {
      push: (message: string) => reject("malformed_row", message),
      get length() {
        return issues.filter(isRejection).length;
      },
    };

    const rawName = row["name"] ?? "";
    const rawSku = row["sku"] ?? "";
    const rawBarcode = row["barcode"] ?? "";
    const rawPrice = row["sale_price_incl_vat"] ?? "";
    const rawVatRate = row["vat_rate"] ?? "";
    const rawStockUnit = row["stock_unit"] ?? "";
    const rawSellingUnit = row["selling_unit"] ?? "";
    const rawQtyPerSellingUnit = row["qty_per_selling_unit"] ?? "";
    const rawIsService = row["is_service"] ?? "";
    const rawActive = row["active"] ?? "";
    const rawCategory = row["menu_category"] ?? "";
    const rawIcon = row["icon"] ?? "";
    const rawDescription = row["description"] ?? "";

    // name
    const name = rawName.trim();
    if (!name) errors.push("Name is required.");

    // is_service — a blank cell keeps its default, an unknown token does not.
    // Getting this wrong in either direction is expensive: a mistyped
    // `is_service` turns goods into a service (no barcode required, no stock,
    // no COGS) or a service into goods that can never be received.
    const isServiceParsed = parseBoolStrict(rawIsService);
    const isService = rawIsService.trim() === "" ? false : (isServiceParsed ?? false);
    if (rawIsService.trim() !== "" && isServiceParsed === null) {
      errors.push(
        `is_service "${rawIsService}" is not a yes/no value. Use ${booleanTokenHelp()}, or leave it blank for no.`,
      );
    }

    // active — same rule. A product imported ACTIVE when the file said
    // otherwise is immediately sellable at the till, which is the whole
    // reason a shop fills this column in.
    const isActiveParsed = parseBoolStrict(rawActive);
    const isActive = rawActive.trim() === "" ? true : (isActiveParsed ?? true);
    if (rawActive.trim() !== "" && isActiveParsed === null) {
      errors.push(
        `active "${rawActive}" is not a yes/no value. Use ${booleanTokenHelp()}, or leave it blank for yes.`,
      );
    }

    // sku — duplicate in file check
    const sku = rawSku.trim() || null;
    if (sku && duplicateSkusInFile.has(sku)) {
      reject("duplicate_sku_in_file", `SKU "${sku}" appears more than once in the file.`);
    }

    // barcode
    const barcode = rawBarcode.trim() || null;
    if (!isService && !barcode) {
      errors.push("Barcode is required for stock products.");
    }
    if (barcode) {
      const normalized = normalizeBarcode(barcode);
      if (duplicateBarcodesInFile.has(normalized)) {
        reject(
          "duplicate_barcode_in_file",
          `Barcode "${barcode}" appears more than once in the file.`,
        );
      }
      // A CHECK DIGIT THAT DOES NOT COMPUTE IS AN ERROR, not a warning.
      //
      // It was a warning, and a warning row is not imported — so the operator
      // was told the product had been "skipped because its SKU already
      // exists", which had not happened, and the product they thought they
      // had created was simply absent. A 13-digit value that fails the
      // checksum is either a typo or not an EAN-13; either way it must not
      // become a scannable barcode on a real product.
      if (/^\d+$/.test(barcode) && barcode.length === 13 && !isValidEan13(barcode)) {
        reject(
          "invalid_barcode_checksum",
          `Barcode "${barcode}" is not a valid EAN-13: its check digit does not compute. ` +
            "Correct the digits, or use a non-EAN code.",
        );
      }
    }

    // menu_category (WP-A5) — VALIDATED against the sections the application
    // knows, not accepted as free text. The column has no CHECK (migration 013
    // explains why) and `resolveCategory` maps anything unknown onto
    // "uncategorised" for display — so an unvalidated import would silently
    // park a typo'd "burgerz" in Other, which looks exactly like having
    // forgotten to categorise it. Better to refuse the row and name the
    // sections.
    const category = normalizeCategoryId(rawCategory);
    if (category !== null && !isKnownCategory(category)) {
      errors.push(
        `Menu category "${rawCategory}" is not one of: ${importableCategoryIds().join(", ")}.`,
      );
    }

    // icon (WP-A5) — bounded and screened; see `isSafeIcon` for the three
    // hazards. Decorative only: a product with none falls back to its
    // section's glyph, so refusing a bad one costs nothing.
    const iconTrimmed = rawIcon.trim();
    const icon = iconTrimmed === "" ? null : iconTrimmed;
    if (icon !== null && !isSafeIcon(icon)) {
      errors.push(
        `Icon "${rawIcon}" is not usable. Use a single glyph, at most ${ICON_MAX_CODE_POINTS} code points, with no markup and no leading = + @.`,
      );
    }

    // description (WP-A5) — free text, bounded so the column cannot become a
    // place to paste a page.
    const descriptionTrimmed = rawDescription.trim();
    const description = descriptionTrimmed === "" ? null : descriptionTrimmed;
    if (description !== null && [...description].length > DESCRIPTION_MAX_CHARS) {
      errors.push(
        `Description is ${[...description].length} characters; the limit is ${DESCRIPTION_MAX_CHARS}.`,
      );
    }

    // price
    const priceInclVatCents = parsePrice(rawPrice);
    if (priceInclVatCents === null) {
      errors.push(
        `Sale price "${rawPrice}" is not an amount. Use digits with at most two decimal places (e.g. 2.50).`,
      );
    }

    // vat rate
    const vatRate = matchVatRate(rawVatRate, vatRates);
    if (!vatRate) {
      const names = vatRates.map((v) => `"${v.name}"`).join(", ");
      errors.push(
        `VAT rate "${rawVatRate}" not found. Available: ${names || "none"}`,
      );
    }

    // units
    const stockUom = matchUom(rawStockUnit, uoms);
    if (!stockUom) {
      errors.push(
        `Stock unit "${rawStockUnit}" not found. Use the code or name from the Units of Measure list.`,
      );
    }

    const saleUom = matchUom(rawSellingUnit, uoms);
    if (!saleUom) {
      errors.push(
        `Selling unit "${rawSellingUnit}" not found. Use the code or name from the Units of Measure list.`,
      );
    }

    // qty per selling unit
    const qtyRaw = rawQtyPerSellingUnit.trim();
    const qtyNum = parseWholeNumber(qtyRaw);
    let saleFactor: Factor = { num: 1, den: 1 };

    if (stockUom && saleUom && stockUom.code === saleUom.code) {
      saleFactor = { num: 1, den: 1 };
    } else if (qtyNum === null || qtyNum < 1) {
      errors.push(
        `qty_per_selling_unit "${rawQtyPerSellingUnit}" must be a positive whole number (e.g. 12).`,
      );
    } else {
      const g = gcd(qtyNum, 1);
      saleFactor = { num: qtyNum / g, den: 1 / g };
    }

    // DB duplicate checks (only when no refusal already blocks the row)
    let skuExistsSkip = false;
    if (sku && errors.length === 0) {
      const exists = await skuExistsInDb(storeId, sku);
      if (exists) {
        skip(
          "sku_exists",
          `SKU "${sku}" already exists in the database — this row will be skipped.`,
        );
        skuExistsSkip = true;
      }
    }

    // RUN THE COLLISION CHECK EVEN WHEN THE ROW IS ALREADY REFUSED for some
    // other reason — but not when the barcode is repeated inside this file
    // (that is the file's own problem, and the owner lookup would report the
    // same clash twice), and not when the row is being skipped because its
    // SKU is already in the database (nothing will be written either way).
    //
    // The gate used to be "no errors yet", which hid a real collision behind
    // an unrelated fault: a row whose barcode belongs to a retired product
    // AND whose check digit is wrong reported only the check digit, so the
    // operator corrected the digits, re-imported, and met the collision on
    // the second pass. One pass should tell them everything that is wrong.
    const duplicateBarcodeInFile = issues.some(
      (i) => i.code === "duplicate_barcode_in_file",
    );
    if (barcode && !skuExistsSkip && !duplicateBarcodeInFile) {
      // WHO holds the barcode, and is that product sellable? The two cases
      // need different advice, and the second one is undiagnosable without
      // being told: the uniqueness constraint is on the barcode row, so a
      // value held by a RETIRED product is still reserved and the operator
      // sees no such product anywhere on the Products page.
      const owner = await findBarcodeOwner(storeId, barcode);
      if (owner) {
        const label = owner.productSku
          ? `${owner.productName} (SKU ${owner.productSku})`
          : owner.productName;
        if (owner.productIsActive) {
          reject(
            "barcode_taken_by_active_product",
            `Barcode "${barcode}" is already used by ${label}.`,
          );
        } else {
          reject(
            "barcode_taken_by_inactive_product",
            `Barcode "${barcode}" belongs to ${label}, which is INACTIVE. ` +
              "Open Products, tick \u201cShow inactive\u201d, and either reactivate that " +
              "product or give this row a different barcode. Greaz will not move a " +
              "barcode from one product to another.",
          );
        }
      }
    }

    // Compute derived price values
    const rateBps = vatRate?.rateBps ?? 0;
    const priceExclVatCents =
      priceInclVatCents !== null ? stripVat(priceInclVatCents, rateBps) : 0;

    const rejections = issues.filter(isRejection);
    const skips = issues.filter((i) => !isRejection(i));
    const status: RowStatus =
      rejections.length > 0 ? "error" : skips.length > 0 ? "warning" : "valid";

    results.push({
      rowNum,
      rawName,
      rawSku,
      rawBarcode,
      rawPrice,
      rawVatRate,
      rawStockUnit,
      rawSellingUnit,
      rawQtyPerSellingUnit,
      rawIsService,
      rawActive,
      rawCategory,
      rawIcon,
      rawDescription,
      name,
      sku,
      barcode,
      priceInclVatCents: priceInclVatCents ?? 0,
      priceExclVatCents,
      vatRate,
      stockUom,
      saleUom,
      saleFactor,
      isService,
      isActive,
      category,
      icon,
      description,
      status,
      issues,
      // Derived, so every existing reader (the preview table, the tests) is
      // unchanged while the counts above are driven by the codes.
      errors: rejections.map((i) => i.message),
      warnings: skips.map((i) => i.message),
    });
  }

  return results;
}
