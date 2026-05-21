import * as XLSX from "xlsx";
import { query } from "../db/client";
import { normalizeBarcode, isValidEan13 } from "./barcode";
import { stripVat } from "./vat";
import { gcd } from "./uom";
import type { VatRate, UnitOfMeasure } from "../db/types";
import type { Factor } from "./uom";

// ─── Public types ────────────────────────────────────────────────────────────

export type RowStatus = "valid" | "warning" | "error";

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

  status: RowStatus;
  errors: string[];
  warnings: string[];
}

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

// ─── Template download ────────────────────────────────────────────────────────

export function downloadTemplate(): void {
  const example = [
    "Coca-Cola 330ml",
    "",
    "6281234567894",
    "2.50",
    "11%",
    "pcs",
    "pcs",
    "1",
    "no",
    "yes",
  ];

  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, example]);
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
    // Skip completely empty rows
    const hasContent = TEMPLATE_HEADERS.some((h) => row[h] !== "");
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

  const pctStr = s.replace(/%$/, "").trim();
  const pct = parseFloat(pctStr);
  if (!isNaN(pct)) {
    const bps = Math.round(pct * 100);
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

function parseBool(input: string, defaultVal: boolean): boolean {
  const s = input.trim().toLowerCase();
  if (!s) return defaultVal;
  if (["yes", "true", "1", "y"].includes(s)) return true;
  if (["no", "false", "0", "n"].includes(s)) return false;
  return defaultVal;
}

function parsePrice(input: string): number | null {
  const s = input.trim().replace(/[$,]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  if (!isNaN(n) && isFinite(n) && n >= 0) return Math.round(n * 100);
  return null;
}

// ─── DB duplicate checks ──────────────────────────────────────────────────────

async function skuExistsInDb(storeId: string, sku: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND sku = ?`,
    [storeId, sku],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function barcodeExistsInDb(
  storeId: string,
  barcode: string,
): Promise<boolean> {
  const lookup = normalizeBarcode(barcode);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM product_barcodes
     WHERE store_id = ? AND lookup_value = ? AND is_active = 1`,
    [storeId, lookup],
  );
  return (rows[0]?.n ?? 0) > 0;
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
    const errors: string[] = [];
    const warnings: string[] = [];

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

    // name
    const name = rawName.trim();
    if (!name) errors.push("Name is required.");

    // is_service
    const isService = parseBool(rawIsService, false);

    // active
    const isActive = parseBool(rawActive, true);

    // sku — duplicate in file check
    const sku = rawSku.trim() || null;
    if (sku && duplicateSkusInFile.has(sku)) {
      errors.push(`SKU "${sku}" appears more than once in the file.`);
    }

    // barcode
    const barcode = rawBarcode.trim() || null;
    if (!isService && !barcode) {
      errors.push("Barcode is required for stock products.");
    }
    if (barcode) {
      const normalized = normalizeBarcode(barcode);
      if (duplicateBarcodesInFile.has(normalized)) {
        errors.push(`Barcode "${barcode}" appears more than once in the file.`);
      }
      if (/^\d+$/.test(barcode) && barcode.length === 13 && !isValidEan13(barcode)) {
        warnings.push("EAN-13 checksum looks invalid — verify before scanning.");
      }
    }

    // price
    const priceInclVatCents = parsePrice(rawPrice);
    if (priceInclVatCents === null) {
      errors.push("Sale price must be a number >= 0 (e.g. 2.50).");
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
    const qtyNum = qtyRaw === "" ? NaN : parseInt(qtyRaw, 10);
    let saleFactor: Factor = { num: 1, den: 1 };

    if (stockUom && saleUom && stockUom.code === saleUom.code) {
      saleFactor = { num: 1, den: 1 };
    } else {
      if (!Number.isInteger(qtyNum) || qtyNum < 1) {
        errors.push(
          "qty_per_selling_unit must be a positive whole number (e.g. 12).",
        );
      } else {
        const g = gcd(qtyNum, 1);
        saleFactor = { num: qtyNum / g, den: 1 / g };
      }
    }

    // DB duplicate checks (only when no errors yet that would block anyway)
    let skuExistsWarning = false;
    if (sku && errors.length === 0) {
      const exists = await skuExistsInDb(storeId, sku);
      if (exists) {
        warnings.push(
          `SKU "${sku}" already exists in the database — this row will be skipped.`,
        );
        skuExistsWarning = true;
      }
    }

    if (barcode && errors.length === 0 && !skuExistsWarning) {
      const exists = await barcodeExistsInDb(storeId, barcode);
      if (exists) {
        errors.push(`Barcode "${barcode}" already exists in the database.`);
      }
    }

    // Compute derived price values
    const rateBps = vatRate?.rateBps ?? 0;
    const priceExclVatCents =
      priceInclVatCents !== null ? stripVat(priceInclVatCents, rateBps) : 0;

    const status: RowStatus =
      errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";

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
      status,
      errors,
      warnings,
    });
  }

  return results;
}
