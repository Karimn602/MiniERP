import { useRef, useState } from "react";
import { productsRepo } from "../db/repos/products";
import { classifyBarcode } from "../lib/barcode";
import {
  downloadTemplate,
  importableCategoryIds,
  parseSpreadsheet,
  validateImportRows,
  type ImportRowValidated,
  type RowStatus,
} from "../lib/productImport";
import { resolveCategory, resolveIcon } from "../lib/menuCategories";
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
        status === "valid" && "bg-good-bg text-good-fg",
        status === "warning" && "bg-warn-bg text-warn-fg",
        status === "error" && "bg-danger-bg text-danger-fg",
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
  const [rejectedCount, setRejectedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  const validRows = rows.filter((r) => r.status === "valid");
  /** Rows that are fine but already in the database: deliberately skipped. */
  const warnRows = rows.filter((r) => r.status === "warning");
  /** Rows REFUSED. Not the same thing, and no longer counted as the same. */
  const errorRows = rows.filter((r) => r.status === "error");

  /**
   * How many rows carry each reason, so the summary can say what is actually
   * wrong instead of attributing every non-import to an existing SKU.
   *
   * A row can hold more than one issue (a bad checksum AND a duplicate SKU),
   * and it is counted under each: these are reason counts, not a partition.
   * The three row counts above are the partition.
   */
  const reasonCounts = rows.reduce<Record<string, number>>((acc, row) => {
    for (const code of new Set(row.issues.map((i) => i.code))) {
      acc[code] = (acc[code] ?? 0) + 1;
    }
    return acc;
  }, {});

  const REASON_LABEL: Record<string, string> = {
    invalid_barcode_checksum: "productImport.reasonChecksum",
    duplicate_sku_in_file: "productImport.reasonDuplicateSkuInFile",
    duplicate_barcode_in_file: "productImport.reasonDuplicateBarcodeInFile",
    sku_exists: "productImport.reasonSkuExists",
    barcode_taken_by_active_product: "productImport.reasonBarcodeActive",
    barcode_taken_by_inactive_product: "productImport.reasonBarcodeInactive",
    malformed_row: "productImport.reasonMalformed",
  };

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

        // One transaction per imported row: the product, its UoM rows and
        // its barcode commit together, so a duplicate barcode half-way down a
        // spreadsheet leaves no partially-created product behind (WP-07).
        await productsRepo.save({
          mode: "create",
          storeId,
          sku,
          name: row.name,
          // The three presentation fields the importer used to drop (WP-A5).
          // `productsRepo.save` normalises the category and trims the icon, so
          // the spreadsheet path and the Products form write the column the
          // same way.
          description: row.description,
          category: row.category,
          icon: row.icon,
          vatRateId: row.vatRate.id,
          vatPricingMode: "inclusive",
          priceExclVatCents: row.priceExclVatCents,
          priceInclVatCents: row.priceInclVatCents,
          reorderPoint: null,
          isService: row.isService,
          // The file's own `active` column, which this call used to drop.
          // `ProductSaveArgs.isActive` defaults to true when it is omitted,
          // so every row of every import landed SELLABLE — including the
          // ones a shop had deliberately marked inactive because they are
          // seasonal, out of contract, or not ready to be ordered. Nothing
          // in the preview contradicted it either, which is why it survived
          // a desktop walkthrough.
          isActive: row.isActive,
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

    // Skipped and rejected are DIFFERENT outcomes and are reported as such:
    // a skipped row was already in the database, a rejected one was refused.
    setImportedCount(imported);
    setSkippedCount(warnRows.length);
    setRejectedCount(errorRows.length);
    setFailedCount(failed);
    setStep("done");

    if (imported > 0) onImported();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div className="flex max-h-[90vh] w-full max-w-4xl animate-scale-in flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl">
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
            className="rounded p-1 text-fg-muted hover:bg-slate-100 hover:text-slate-700"
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
                  className="mt-2 text-xs font-medium text-brand-700 underline hover:text-brand-900"
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

                {/* The optional menu columns (WP-A5). Listed separately and
                    labelled optional, because a file without them is still a
                    valid file — that is the backward-compatibility promise. */}
                <p className="mb-2 mt-4 font-medium text-slate-800">
                  {t("productImport.optionalCols")}
                </p>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-3">
                  <span>
                    <code>menu_category</code> — {t("productImport.colCategoryDesc")}
                  </span>
                  <span><code>icon</code> — {t("productImport.colIconDesc")}</span>
                  <span>
                    <code>description</code> — {t("productImport.colDescriptionDesc")}
                  </span>
                </div>
                <p className="mt-2 text-fg-muted">
                  {t("productImport.categoryValues", {
                    values: importableCategoryIds().join(", "),
                  })}
                </p>
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-warn-line bg-warn-bg px-4 py-3 text-xs text-warn-fg">
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
                <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-xs text-danger-fg">
                  {parseError}
                </div>
              )}
            </div>
          )}

          {/* ── PREVIEW step ── */}
          {step === "preview" && (
            <div className="space-y-4">
              {/* Summary bar */}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-3 text-sm">
                  <span
                    data-testid="count-ready"
                    className="rounded-full bg-good-bg px-3 py-1 text-good-fg"
                  >
                    {t("productImport.readyToImport", { count: String(validRows.length) })}
                  </span>
                  {errorRows.length > 0 && (
                    <span
                      data-testid="count-rejected"
                      className="rounded-full bg-danger-bg px-3 py-1 text-danger-fg"
                    >
                      {t("productImport.rejected", { count: String(errorRows.length) })}
                    </span>
                  )}
                  {warnRows.length > 0 && (
                    <span
                      data-testid="count-skipped"
                      className="rounded-full bg-warn-bg px-3 py-1 text-warn-fg"
                    >
                      {t("productImport.willBeSkipped", { count: String(warnRows.length) })}
                    </span>
                  )}
                </div>
                {/* WHY, by reason. The old summary had one bucket and called
                    it "SKU exists", so a row dropped for a bad check digit
                    was reported as a clash that had not happened. */}
                {Object.keys(reasonCounts).length > 0 && (
                  <ul
                    data-testid="reason-breakdown"
                    className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted"
                  >
                    {Object.entries(reasonCounts).map(([code, n]) => (
                      <li key={code} data-testid={`reason-${code}`}>
                        {t(REASON_LABEL[code] ?? "productImport.reasonMalformed", {
                          count: String(n),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Opening stock note */}
              <div className="rounded-lg border border-warn-line bg-warn-bg px-4 py-2 text-xs text-warn-fg">
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
                      <th className="px-3 py-2">{t("productImport.colClassHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colSectionHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colIconHeader")}</th>
                      <th className="px-3 py-2">{t("productImport.colIssues")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => (
                      <tr
                        key={row.rowNum}
                        className={clsx(
                          row.status === "error" && "bg-danger-bg",
                          row.status === "warning" && "bg-warn-bg",
                        )}
                      >
                        <td className="px-3 py-2 text-fg-muted">{row.rowNum}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-800">
                          {row.rawName || (
                            <span className="italic text-danger-fg">
                              {t("productImport.blankName")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.rawSku || (
                            <span className="text-fg-muted">
                              {t("productImport.autoSku")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-600">
                          {row.rawBarcode || <span className="font-sans text-fg-muted">—</span>}
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
                        {/* WHAT THIS ROW WILL BECOME, in the two dimensions
                            that decide whether it can be sold and whether it
                            holds stock. Shown as the RESOLVED classification,
                            not the raw cells: a blank `active` means yes and
                            a blank `is_service` means goods, and a preview
                            that printed the empty cell would leave the
                            operator to remember which way each default
                            falls. The active flag in particular had no
                            representation anywhere on this screen while the
                            importer was quietly ignoring it. */}
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <span
                              data-testid={`row-${row.rowNum}-active`}
                              className={clsx(
                                "rounded-chip border px-1.5 py-0.5 text-[10px] font-bold uppercase",
                                row.isActive
                                  ? "border-good-line bg-good-bg text-good-fg"
                                  : "border-line bg-paper text-fg-muted",
                              )}
                            >
                              {t(
                                row.isActive
                                  ? "productImport.classActive"
                                  : "productImport.classInactive",
                              )}
                            </span>
                            <span
                              data-testid={`row-${row.rowNum}-kind`}
                              className="rounded-chip border border-line bg-paper px-1.5 py-0.5 text-[10px] font-bold uppercase text-fg-muted"
                            >
                              {t(
                                row.isService
                                  ? "productImport.classService"
                                  : "productImport.classStocked",
                              )}
                            </span>
                          </div>
                        </td>
                        {/* The RESOLVED section, not the raw cell: a row that
                            named no section shows what it will actually be,
                            which is uncategorised. */}
                        <td className="px-3 py-2 text-slate-600">
                          {row.category
                            ? t(resolveCategory(row.category).labelKey)
                            : t("menuCategory.none")}
                        </td>
                        <td className="px-3 py-2 text-center text-base">
                          {row.icon ?? (
                            <span className="text-xs text-fg-muted">
                              {resolveIcon(null, row.category)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-xs">
                          {row.errors.map((e, i) => (
                            <div key={i} className="text-danger-fg">{e}</div>
                          ))}
                          {row.warnings.map((w, i) => (
                            <div key={i} className="text-warn-fg">{w}</div>
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
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
              <p className="text-sm">
                {t("productImport.importing", { count: String(validRows.length) })}
              </p>
            </div>
          )}

          {/* ── DONE step ── */}
          {step === "done" && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-good-bg text-good-fg text-xl">
                  ✓
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {t("productImport.doneTitle")}
                  </p>
                  <p className="text-xs text-slate-500">
                    <span data-testid="done-counts">
                      {t("productImport.doneCreated", { count: String(importedCount) })}
                      {skippedCount > 0 &&
                        t("productImport.doneSkipped", { count: String(skippedCount) })}
                      {rejectedCount > 0 &&
                        t("productImport.doneRejected", { count: String(rejectedCount) })}
                      {failedCount > 0 &&
                        t("productImport.doneFailed", { count: String(failedCount) })}
                    </span>
                  </p>
                </div>
              </div>

              {failedCount > 0 && (
                <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-xs text-danger-fg">
                  {t("productImport.failedNote", { count: String(failedCount) })}
                </div>
              )}

              <div className="rounded-lg border border-warn-line bg-warn-bg px-4 py-3 text-xs text-warn-fg">
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
