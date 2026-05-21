import { useRef, useState } from "react";
import { productsRepo } from "../db/repos/products";
import { classifyBarcode } from "../lib/barcode";
import {
  downloadTemplate,
  parseSpreadsheet,
  validateImportRows,
  type ImportRowValidated,
  type RowStatus,
} from "../lib/productImport";
import type { VatRate, UnitOfMeasure } from "../db/types";
import { formatUsd } from "../lib/money";
import { Button } from "./ui/Button";
import clsx from "clsx";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  storeId: string;
  vatRates: VatRate[];
  uoms: UnitOfMeasure[];
  onClose: () => void;
  onImported: () => void;
}

// ─── Step type ────────────────────────────────────────────────────────────────

type Step = "pick" | "validating" | "preview" | "importing" | "done";

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RowStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        status === "valid" && "bg-emerald-100 text-emerald-800",
        status === "warning" && "bg-amber-100 text-amber-800",
        status === "error" && "bg-red-100 text-red-800",
      )}
    >
      {status === "valid" && "Ready"}
      {status === "warning" && "Skip"}
      {status === "error" && "Error"}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ProductImportDialog({
  storeId,
  vatRates,
  uoms,
  onClose,
  onImported,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("pick");
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRowValidated[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  const validRows = rows.filter((r) => r.status === "valid");
  const warnRows = rows.filter((r) => r.status === "warning");
  const errorRows = rows.filter((r) => r.status === "error");

  // ── File selected ──────────────────────────────────────────────────────────

  async function handleFile(file: File) {
    setParseError(null);
    setStep("validating");

    try {
      const rawRows = await parseSpreadsheet(file);
      const validated = await validateImportRows(rawRows, storeId, vatRates, uoms);
      setRows(validated);
      setStep("preview");
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      setStep("pick");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    // reset so the same file can be re-selected after fixing
    e.target.value = "";
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  async function handleImport() {
    setStep("importing");

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of validRows) {
      if (!row.vatRate || !row.stockUom || !row.saleUom) {
        failed++;
        continue;
      }

      try {
        let sku = row.sku;
        if (!sku) {
          sku = await productsRepo.nextAutoSku(storeId);
        }

        await productsRepo.create({
          storeId,
          sku,
          name: row.name,
          description: null,
          vatRateId: row.vatRate.id,
          vatPricingMode: "inclusive",
          priceExclVatCents: row.priceExclVatCents,
          priceInclVatCents: row.priceInclVatCents,
          avgCostExclVatCents: 0,
          avgCostInclVatCents: 0,
          quantityOnHand: 0,
          reorderPoint: null,
          isService: row.isService,
          barcode: row.barcode ?? null,
          barcodeType: row.barcode ? classifyBarcode(row.barcode) : null,
          baseUomCode: row.stockUom.code,
          saleUomCode: row.saleUom.code,
          saleFactor: row.saleFactor,
          salePriceExclVatCents: null,
          salePriceInclVatCents: null,
        });

        imported++;
      } catch {
        failed++;
      }
    }

    skipped = warnRows.length;

    setImportedCount(imported);
    setSkippedCount(skipped);
    setFailedCount(failed);
    setStep("done");

    if (imported > 0) onImported();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Import products
            </h2>
            <p className="text-xs text-slate-500">
              CSV or XLSX — create new products and barcodes from a spreadsheet
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ── PICK step ── */}
          {(step === "pick" || step === "validating") && (
            <div className="space-y-5">
              {/* Template download */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  1. Download the template
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Fill in the spreadsheet with your product catalog, then upload it below.
                </p>
                <button
                  onClick={downloadTemplate}
                  className="mt-2 text-xs font-medium text-teal-700 underline hover:text-teal-900"
                >
                  Download product_import_template.xlsx
                </button>
              </div>

              {/* Required columns reference */}
              <div className="rounded-lg border border-slate-200 p-4 text-xs text-slate-600">
                <p className="mb-2 font-medium text-slate-800">Required columns</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  <span><code>name</code> — product name</span>
                  <span><code>sku</code> — leave blank to auto-generate</span>
                  <span><code>barcode</code> — required unless service</span>
                  <span><code>sale_price_incl_vat</code> — USD e.g. 2.50</span>
                  <span><code>vat_rate</code> — e.g. "11%" or "Standard"</span>
                  <span><code>stock_unit</code> — e.g. pcs, kg</span>
                  <span><code>selling_unit</code> — same as stock_unit or e.g. box</span>
                  <span><code>qty_per_selling_unit</code> — e.g. 12</span>
                  <span><code>is_service</code> — yes / no</span>
                  <span><code>active</code> — yes / no</span>
                </div>
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <span className="font-semibold">Note:</span> Opening stock
                quantities are not imported here. After importing your product
                catalog, use <span className="font-medium">Inventory → Adjustments</span> to
                set opening quantities and costs.
              </div>

              {/* File picker */}
              <div>
                <p className="mb-2 text-sm font-medium text-slate-800">
                  2. Upload your file
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={step === "validating"}
                >
                  {step === "validating" ? "Validating…" : "Choose file (.xlsx or .csv)"}
                </Button>
              </div>

              {parseError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                  {parseError}
                </div>
              )}
            </div>
          )}

          {/* ── PREVIEW step ── */}
          {step === "preview" && (
            <div className="space-y-4">
              {/* Summary bar */}
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">
                  {validRows.length} ready to import
                </span>
                {warnRows.length > 0 && (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                    {warnRows.length} will be skipped (SKU exists)
                  </span>
                )}
                {errorRows.length > 0 && (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-red-800">
                    {errorRows.length} have errors
                  </span>
                )}
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                <span className="font-semibold">Note:</span> Opening stock
                quantities are not imported. Use Inventory → Adjustments after
                import.
              </div>

              {/* Preview table */}
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Barcode</th>
                      <th className="px-3 py-2 text-right">Price incl. VAT</th>
                      <th className="px-3 py-2">VAT</th>
                      <th className="px-3 py-2">Stock unit</th>
                      <th className="px-3 py-2">Sell unit</th>
                      <th className="px-3 py-2">Qty/unit</th>
                      <th className="px-3 py-2">Issues</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => (
                      <tr
                        key={row.rowNum}
                        className={clsx(
                          row.status === "error" && "bg-red-50",
                          row.status === "warning" && "bg-amber-50",
                        )}
                      >
                        <td className="px-3 py-2 text-slate-400">{row.rowNum}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-800">
                          {row.rawName || <span className="italic text-red-400">blank</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.rawSku || <span className="text-slate-400">auto</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-600">
                          {row.rawBarcode || <span className="font-sans text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                          {row.priceInclVatCents > 0
                            ? formatUsd(row.priceInclVatCents)
                            : row.rawPrice || "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.vatRate?.name ?? row.rawVatRate}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.stockUom?.code ?? row.rawStockUnit}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.saleUom?.code ?? row.rawSellingUnit}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.rawQtyPerSellingUnit || "1"}
                        </td>
                        <td className="px-3 py-2 max-w-xs">
                          {row.errors.map((e, i) => (
                            <div key={i} className="text-red-700">{e}</div>
                          ))}
                          {row.warnings.map((w, i) => (
                            <div key={i} className="text-amber-700">{w}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Change file */}
              <button
                onClick={() => {
                  setRows([]);
                  setStep("pick");
                }}
                className="text-xs text-slate-500 underline hover:text-slate-700"
              >
                Choose a different file
              </button>
            </div>
          )}

          {/* ── IMPORTING step ── */}
          {step === "importing" && (
            <div className="flex flex-col items-center gap-3 py-12 text-slate-600">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
              <p className="text-sm">Importing {validRows.length} products…</p>
            </div>
          )}

          {/* ── DONE step ── */}
          {step === "done" && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xl">
                  ✓
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Import complete
                  </p>
                  <p className="text-xs text-slate-500">
                    {importedCount} product{importedCount !== 1 ? "s" : ""} created
                    {skippedCount > 0 && `, ${skippedCount} skipped`}
                    {failedCount > 0 && `, ${failedCount} failed unexpectedly`}
                  </p>
                </div>
              </div>

              {failedCount > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                  {failedCount} row{failedCount !== 1 ? "s" : ""} failed during
                  import (e.g. duplicate barcode detected at write time). These
                  products were not created.
                </div>
              )}

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <span className="font-semibold">Next step:</span> Go to{" "}
                <span className="font-medium">Inventory → Adjustments</span> to
                set opening stock quantities and costs for the imported products.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          {step === "preview" && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleImport()}
                disabled={validRows.length === 0}
              >
                Import {validRows.length} product{validRows.length !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {(step === "pick" || step === "validating") && (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === "done" && (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
