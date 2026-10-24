// @vitest-environment jsdom
/**
 * THE IMPORT PREVIEW AND WHAT IT ACTUALLY SAVES (Codex WP-A finding 4)
 *
 * The importer read every row's `active` column, carried the parsed flag onto
 * the validated row — and then dropped it on the floor at the one call that
 * writes. `ProductSaveArgs.isActive` is optional and defaults to TRUE, so a
 * row the shop had deliberately marked inactive was created sellable, and
 * appeared on the register's menu grid the moment the import finished.
 *
 * Nothing on the preview screen contradicted it, which is why a desktop
 * walkthrough did not catch it: the table showed the name, the price, the VAT
 * rate, the units and the section, and said nothing about whether the product
 * would be sellable or whether it held stock. Both are now columns.
 *
 * This file pins the two layers that live in the frontend:
 *
 *   * the PREVIEW states the resolved classification, including the defaults
 *     a blank cell falls back to;
 *   * the SAVE CALL carries `isActive` and `isService` from the row.
 *
 * The third layer — the row the database ends up holding — is pinned in
 * `src-tauri/src/tests/catalog.rs`, against a real SQLite database, because
 * `save_product` in Rust is the only thing that writes it. A frontend test
 * asserting on its own state would prove nothing about persistence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { ImportRowValidated } from "../../src/lib/productImport";
import type { UnitOfMeasure, VatRate } from "../../src/db/types";

const save = vi.fn();
const nextAutoSku = vi.fn();
const parseSpreadsheet = vi.fn();
const validateImportRows = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/db/repos/products", () => ({
  productsRepo: {
    save: (...a: unknown[]) => save(...a),
    nextAutoSku: (...a: unknown[]) => nextAutoSku(...a),
  },
}));
vi.mock("../../src/lib/productImport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/productImport")>();
  return {
    ...actual,
    parseSpreadsheet: (...a: unknown[]) => parseSpreadsheet(...a),
    validateImportRows: (...a: unknown[]) => validateImportRows(...a),
  };
});

import { ProductImportDialog } from "../../src/components/ProductImportDialog";

const VAT: VatRate = {
  id: "vat-11",
  name: "Standard 11%",
  rateBps: 1100,
  isExempt: false,
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
};

const PCS: UnitOfMeasure = {
  code: "pcs",
  name: "Pieces",
  category: "count",
  symbol: "pcs",
  isActive: true,
};

/** A validated row in whatever classification the test is about. */
function validRow(over: Partial<ImportRowValidated> = {}): ImportRowValidated {
  return {
    rowNum: 2,
    rawName: "Seasonal Shake",
    rawSku: "",
    rawBarcode: "6281234567895",
    rawPrice: "4.00",
    rawVatRate: "11%",
    rawStockUnit: "pcs",
    rawSellingUnit: "pcs",
    rawQtyPerSellingUnit: "1",
    rawIsService: "no",
    rawActive: "no",
    rawCategory: "drinks",
    rawIcon: "",
    rawDescription: "",
    name: "Seasonal Shake",
    sku: null,
    barcode: "6281234567895",
    priceInclVatCents: 400,
    priceExclVatCents: 360,
    vatRate: VAT,
    stockUom: PCS,
    saleUom: PCS,
    saleFactor: { num: 1, den: 1 },
    isService: false,
    isActive: false,
    category: "drinks",
    icon: null,
    description: null,
    status: "valid",
    issues: [],
    errors: [],
    warnings: [],
    ...over,
  } as ImportRowValidated;
}

async function openPreviewWith(rows: ImportRowValidated[]) {
  parseSpreadsheet.mockResolvedValue(rows.map(() => ({})));
  validateImportRows.mockResolvedValue(rows);

  render(
    <I18nProvider>
      <ProductImportDialog
        storeId="store-1"
        vatRates={[VAT]}
        uoms={[PCS]}
        onClose={() => {}}
        onImported={() => {}}
      />
    </I18nProvider>,
  );

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["x"], "menu.xlsx");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);

  await waitFor(() => expect(validateImportRows).toHaveBeenCalled());
}

beforeEach(() => {
  save.mockReset().mockResolvedValue({ id: "p-new" });
  nextAutoSku.mockReset().mockResolvedValue("AUTO-1");
  parseSpreadsheet.mockReset();
  validateImportRows.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the import preview states what each row will BECOME (GZ-A-04)", () => {
  it("shows a row the file marked inactive as Inactive", async () => {
    await openPreviewWith([validRow()]);
    expect(screen.getByTestId("row-2-active").textContent).toMatch(/inactive/i);
  });

  it("shows an unmarked row as Active, which is the default it will take", async () => {
    await openPreviewWith([validRow({ rawActive: "", isActive: true })]);
    const chip = screen.getByTestId("row-2-active").textContent ?? "";
    expect(chip).toMatch(/active/i);
    expect(chip).not.toMatch(/inactive/i);
  });

  it("distinguishes a service from a stocked product", async () => {
    await openPreviewWith([
      validRow({ rowNum: 2, isService: true }),
      validRow({ rowNum: 3, isService: false, isActive: true }),
    ]);
    expect(screen.getByTestId("row-2-kind").textContent).toMatch(/service/i);
    expect(screen.getByTestId("row-3-kind").textContent).toMatch(/stocked/i);
  });
});

describe("the import SAVE CALL carries the row's own flags (GZ-A-04)", () => {
  it("passes isActive: false for a row the file marked inactive", async () => {
    // THE DEFECT: this argument was absent, and `ProductSaveArgs.isActive`
    // defaults to true, so the product was created sellable.
    await openPreviewWith([validRow()]);

    fireEvent.click(screen.getByRole("button", { name: /import 1 product/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const args = save.mock.calls[0][0];
    expect(args.isActive).toBe(false);
    expect(args.isService).toBe(false);
    expect(args.name).toBe("Seasonal Shake");
  });

  it("passes isActive: true for an ordinary row", async () => {
    await openPreviewWith([validRow({ rawActive: "yes", isActive: true })]);

    fireEvent.click(screen.getByRole("button", { name: /import 1 product/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].isActive).toBe(true);
  });

  it("passes the service classification too", async () => {
    await openPreviewWith([validRow({ isService: true, isActive: true, barcode: null })]);

    fireEvent.click(screen.getByRole("button", { name: /import 1 product/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].isService).toBe(true);
  });
});

// ===========================================================================
// Codex round 2 — the preview and the final summary COUNT accurately
// ===========================================================================

describe("the import summary reports each outcome under its own reason (GZ-A-07)", () => {
  /** A row carrying one coded issue, in the shape the validator returns. */
  function rejected(rowNum: number, code: string, message: string): ImportRowValidated {
    return validRow({
      rowNum,
      status: "error",
      issues: [{ code, message }],
      errors: [message],
      warnings: [],
      isActive: true,
    } as Partial<ImportRowValidated>);
  }

  function skipped(rowNum: number): ImportRowValidated {
    const message = 'SKU "GZ-DUP" already exists in the database — this row will be skipped.';
    return validRow({
      rowNum,
      status: "warning",
      issues: [{ code: "sku_exists", message, skip: true }],
      errors: [],
      warnings: [message],
      isActive: true,
    } as Partial<ImportRowValidated>);
  }

  it("counts ready, rejected and skipped as three different things", async () => {
    await openPreviewWith([
      validRow({ rowNum: 2, isActive: true }),
      skipped(3),
      rejected(4, "invalid_barcode_checksum", 'Barcode "5281234567891" is not a valid EAN-13.'),
      rejected(5, "malformed_row", 'Sale price "2abc" is not an amount.'),
    ]);

    expect(screen.getByTestId("count-ready").textContent).toMatch(/\b1\b/);
    expect(screen.getByTestId("count-rejected").textContent).toMatch(/\b2\b/);
    expect(screen.getByTestId("count-skipped").textContent).toMatch(/\b1\b/);
  });

  it("does not attribute a rejected row to an existing SKU", async () => {
    // THE DEFECT: every non-imported row was reported as "will be skipped
    // (SKU exists)", so a product dropped for a bad check digit looked like a
    // clash that had not happened — and the operator had nothing to fix.
    await openPreviewWith([
      rejected(2, "invalid_barcode_checksum", 'Barcode "5281234567891" is not a valid EAN-13.'),
    ]);

    expect(screen.queryByTestId("count-skipped")).toBeNull();
    expect(screen.getByTestId("count-rejected").textContent).toMatch(/\b1\b/);
    const breakdown = screen.getByTestId("reason-breakdown").textContent ?? "";
    expect(breakdown).toMatch(/check digit/i);
    expect(breakdown).not.toMatch(/sku/i);
  });

  it("names the reason for each refusal in the breakdown", async () => {
    await openPreviewWith([
      rejected(2, "invalid_barcode_checksum", "bad checksum"),
      rejected(3, "barcode_taken_by_inactive_product", "held by an inactive product"),
      rejected(4, "duplicate_barcode_in_file", "twice in this file"),
      skipped(5),
    ]);

    expect(screen.getByTestId("reason-invalid_barcode_checksum")).toBeTruthy();
    expect(screen.getByTestId("reason-barcode_taken_by_inactive_product").textContent).toMatch(
      /inactive/i,
    );
    expect(screen.getByTestId("reason-duplicate_barcode_in_file")).toBeTruthy();
    expect(screen.getByTestId("reason-sku_exists").textContent).toMatch(/sku/i);
  });

  it("reports created, skipped and rejected separately when the import finishes", async () => {
    await openPreviewWith([
      validRow({ rowNum: 2, isActive: true }),
      skipped(3),
      rejected(4, "invalid_barcode_checksum", "bad checksum"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /import 1 product/i }));
    await waitFor(() => expect(screen.getByTestId("done-counts")).toBeTruthy());

    const summary = screen.getByTestId("done-counts").textContent ?? "";
    expect(summary).toMatch(/1 product\(s\) created/i);
    expect(summary).toMatch(/1 skipped/i);
    expect(summary).toMatch(/1 rejected/i);
    // One product was created, and it is the valid row — not the rejected one.
    expect(save).toHaveBeenCalledTimes(1);
  });
});
