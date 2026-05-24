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
import { useTranslation } from "../lib/i18n";
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
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        status === "valid" && "bg-emerald-100 text-emerald-800",
        status === "warning" && "bg-amber-100 text-amber-800",
        status === "error" && "bg-red-100 text-red-800",
      )}
    >
      {status === "valid" && t("productImport.statusReady")}
      {status === "warning" && t("productImport.statusSkip")}
      {status === "error" && t("productImport.statusError")}
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
  const { t } = useTranslation();
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
              {t("productImport.title")}
            </h2>
            <p className="text-xs text-slate-500">
              {t("productImport.subtitle")}
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
                  {t("productImport.step1Title")}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {t("productImport.step1Desc")}
                </p>
                <button
                  onClick={downloadTemplate}
                  className="mt-2 text-xs font-medium text-teal-700 underline hover:text-teal-900"
                >
                  {t("productImport.downloadTemplate")}
                </button>
              </div>

              {/* Required columns reference */}
              <div className="rounded-lg border border-slate-200 p-4 text-xs text-slate-600">
                <p className="mb-2 font-medium text-slate-800">{t("productImport.requiredCols")}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  <span><code>name</code> — {t("productImport.colNameDesc")}</span>
                  <span><code>sku</code> — {t("productImport.colSkuDesc")}</span>
                  <span><code>barcode</code> — {t("productImport.colBarcodeDesc")}</span>
                  <span><code>sale_price_incl_vat</code> — {t("productImport.colSalePriceDesc")}</span>
                  <span><code>vat_rate</code> — {t("productImport.colVatRateDesc")}</span>
                  <span><code>stock_unit</code> — {t("productImport.colStockUnitDesc")}</span>
                  <span><code>selling_unit</code> — {t("productImport.colSellingUnitDesc")}</span>
                  <span><code>qty_per_selling_unit</code> — {t("productImport.colQtyPerUnitDesc")}</span>
                  <span><code>is_service</code> — {t("productImport.colIsServiceDesc")}</span>
                  <span><code>active</code> — {t("productImport.colActiveDesc")}</span>
                </div>
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <span className="font-semibold">{t("productImport.noteLabel")}</span>{" "}
                {t("productImport.openingStockNote")}{" "}
                <span className="font-medium">{t("productImport.inventoryAdjLink")}</span>{" "}
                {t("productImport.openingStockSuffix")}
              </div>

              {/* File picker */}
              <div>
                <p className="mb-2 text-sm font-medium text-slate-800">
                  {t("productImport.step2Title")}
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
                  {step === "validating"
                    ? t("productImport.validating")
                    : t("productImport.chooseFile")}
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
                  {t("productImport.readyToImport", { count: String(validRows.length) })}
                </span>
                {warnRows.length > 0 && (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                    {t("productImport.willBeSkipped", { count: String(warnRows.length) })}
                  </span>
                )}
                {errorRows.length > 0 && (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-red-800">
                    {t("productImport.haveErrors", { count: String(errorRows.length) })}
                  </span>
                )}
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                <span className="font-semibold">{t("productImport.noteLabel")}</span>{" "}
                {t("productImport.openingStockNoteShort")}{" "}
                <span className="font-medium">{t("productImport.inventoryAdjLink")}</span>{" "}
                {t("productImport.openingStockSuffixShort")}
              </div>

              {/* Preview table */}
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">{t("productImport.colHash")}</th>
                      <th className="px-3 py-2">{t("productImport.colStatus")}</th>
                      <th className="px-3 py-2">{t("productImport.colNameHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colSkuHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colBarcodeHeader")}</th>
                      <th className="px-3 py-2 text-right">{t("productImport.colPriceHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colVatHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colStockUnitHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colSellUnitHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colQtyUnit")}</th>
                      <th className="px-3 py-2">{t("productImport.colIssues")}</th>
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
                          {row.rawName || (
                            <span className="italic text-red-400">
                              {t("productImport.blankName")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.rawSku || (
                            <span className="text-slate-400">
                              {t("productImport.autoSku")}
                            </span>
                          )}
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
                {t("productImport.chooseDifferentFile")}
              </button>
            </div>
          )}

          {/* ── IMPORTING step ── */}
          {step === "importing" && (
            <div className="flex flex-col items-center gap-3 py-12 text-slate-600">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
              <p className="text-sm">
                {t("productImport.importing", { count: String(validRows.length) })}
              </p>
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
                    {t("productImport.doneTitle")}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t("productImport.doneCreated", { count: String(importedCount) })}
                    {skippedCount > 0 &&
                      t("productImport.doneSkipped", { count: String(skippedCount) })}
                    {failedCount > 0 &&
                      t("productImport.doneFailed", { count: String(failedCount) })}
                  </p>
                </div>
              </div>

              {failedCount > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                  {t("productImport.failedNote", { count: String(failedCount) })}
                </div>
              )}

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <span className="font-semibold">{t("productImport.nextStepLabel")}</span>{" "}
                {t("productImport.nextStepText")}{" "}
                <span className="font-medium">{t("productImport.nextStepLink")}</span>{" "}
                {t("productImport.nextStepSuffix")}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
          {step === "preview" && (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleImport()}
                disabled={validRows.length === 0}
              >
                {t("productImport.importButton", { count: String(validRows.length) })}
              </Button>
            </>
          )}
          {(step === "pick" || step === "validating") && (
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          )}
          {step === "done" && (
            <Button variant="primary" onClick={onClose}>
              {t("productImport.done")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
