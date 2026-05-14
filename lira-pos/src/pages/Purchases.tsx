import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { purchasesRepo, type PostPurchaseLineInput } from "../db/repos/purchases";
import type {
  Purchase,
  PurchaseType,
  ProductWithUoms,
  ProductUom,
  Supplier,
  VatPricingMode,
} from "../db/types";
import { formatUsd, parseUsdInput } from "../lib/money";
import { formatBps } from "../lib/vat";
import { todayLocalDate, formatPrettyDate, relativeFromToday } from "../lib/dates";
import { computeLineMath, type PurchaseLineMath } from "../lib/purchaseMath";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { ProductPicker } from "../components/ProductPicker";
import { SupplierPicker } from "../components/SupplierPicker";
import { newId } from "../lib/ids";
import clsx from "clsx";

// ============================================================================
// Line draft — what we hold per-line while the form is open
// ============================================================================

interface LineDraft {
  draftId: string;
  product: ProductWithUoms;
  selectedUomId: string;
  quantityInput: string;
  unitCostInput: string;
  costMode: VatPricingMode;
  // computed live; null if inputs invalid
  math: PurchaseLineMath | null;
  error: string | null;
}

function buildLineMath(line: Omit<LineDraft, "math" | "error">): {
  math: PurchaseLineMath | null;
  error: string | null;
} {
  const qty = Number(line.quantityInput);
  if (!Number.isInteger(qty) || qty <= 0) {
    return { math: null, error: "Quantity must be a positive whole number." };
  }
  let unitCostCents: number;
  try {
    unitCostCents = parseUsdInput(line.unitCostInput);
  } catch {
    return { math: null, error: "Invalid unit cost." };
  }
  if (unitCostCents < 0) {
    return { math: null, error: "Unit cost cannot be negative." };
  }
  const uom = line.product.uoms.find((u) => u.id === line.selectedUomId);
  if (!uom) {
    return { math: null, error: "Pick a UoM." };
  }
  try {
    const math = computeLineMath({
      quantityInUom: qty,
      unitCostInUomCents: unitCostCents,
      unitCostInUomMode: line.costMode,
      factor: uom.factor,
      vatBps: line.product.vatRate.rateBps,
    });
    return { math, error: null };
  } catch (e) {
    return {
      math: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// Page
// ============================================================================

export default function Purchases() {
  const { storeId, userId } = useActiveContext();

  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [justSaved, setJustSaved] = useState<{ number: number } | null>(null);

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await purchasesRepo.list({ storeId, limit: 200 });
      setPurchases(rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function handlePosted(purchaseNumber: number) {
    setFormOpen(false);
    setJustSaved({ number: purchaseNumber });
    setTimeout(() => setJustSaved(null), 4000);
    void reload();
  }

  if (loading && purchases.length === 0) {
    return <div className="text-sm text-slate-500">Loading purchases…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Purchases</h2>
          <p className="text-sm text-slate-600">
            Record stock in from suppliers. Posting updates inventory and
            weighted-average cost atomically.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {justSaved && (
            <span className="text-sm text-emerald-700">
              ✓ Posted #{justSaved.number}
            </span>
          )}
          <Button
            variant={formOpen ? "ghost" : "primary"}
            onClick={() => setFormOpen((o) => !o)}
          >
            {formOpen ? "Close form" : "New purchase"}
          </Button>
        </div>
      </div>

      {formOpen && storeId && (
        <NewPurchaseForm
          storeId={storeId}
          userId={userId}
          onPosted={handlePosted}
          onCancel={() => setFormOpen(false)}
        />
      )}

      <Card>
        <CardHeader
          title="Recent purchases"
          subtitle={
            loading
              ? "Loading…"
              : `${purchases.length} ${purchases.length === 1 ? "record" : "records"}`
          }
        />
        {loadError ? (
          <CardBody>
            <p className="text-sm text-red-700">Failed to load: {loadError}</p>
          </CardBody>
        ) : purchases.length === 0 ? (
          <CardBody>
            <div className="py-8 text-center text-sm text-slate-500">
              No purchases yet. Use "New purchase" to record one.
            </div>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">#</th>
                  <th className="px-5 py-2 font-medium">Date</th>
                  <th className="px-5 py-2 font-medium">Type</th>
                  <th className="px-5 py-2 font-medium">Reference</th>
                  <th className="px-5 py-2 font-medium text-right">Total (incl. VAT)</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {purchases.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2 font-medium text-slate-900">
                      #{p.purchaseNumber}
                    </td>
                    <td className="px-5 py-2 text-slate-700">
                      <div>{formatPrettyDate(p.purchaseDate)}</div>
                      <div className="text-xs text-slate-500">
                        {relativeFromToday(p.purchaseDate)}
                      </div>
                    </td>
                    <td className="px-5 py-2 text-xs">
                      <span
                        className={clsx(
                          "rounded px-2 py-0.5",
                          p.purchaseType === "opening"
                            ? "bg-indigo-100 text-indigo-700"
                            : "bg-slate-100 text-slate-700",
                        )}
                      >
                        {p.purchaseType}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-xs text-slate-600">
                      {p.supplierReference ?? "—"}
                    </td>
                    <td className="px-5 py-2 text-right font-medium text-slate-900">
                      {formatUsd(p.totalInclVatCents)}
                    </td>
                    <td className="px-5 py-2">
                      <span
                        className={clsx(
                          "rounded px-2 py-0.5 text-xs font-medium",
                          p.status === "posted" && "bg-emerald-100 text-emerald-800",
                          p.status === "draft" && "bg-amber-100 text-amber-800",
                          p.status === "voided" && "bg-slate-200 text-slate-600 line-through",
                        )}
                      >
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ============================================================================
// New Purchase Form
// ============================================================================

function NewPurchaseForm({
  storeId,
  userId,
  onPosted,
  onCancel,
}: {
  storeId: string;
  userId: string | null;
  onPosted: (purchaseNumber: number) => void;
  onCancel: () => void;
}) {
  const [purchaseType, setPurchaseType] = useState<PurchaseType>("normal");
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierReference, setSupplierReference] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayLocalDate());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function addLine(product: ProductWithUoms) {
    // Default UoM: product's default purchase UoM, falling back to default sale, then base.
    const defaultUom: ProductUom =
      product.uoms.find((u) => u.isDefaultPurchase) ??
      product.defaultSaleUom ??
      product.baseUom;

    const draft: Omit<LineDraft, "math" | "error"> = {
      draftId: newId(),
      product,
      selectedUomId: defaultUom.id,
      quantityInput: "1",
      unitCostInput: "",
      costMode: product.vatPricingMode,
    };
    const { math, error } = buildLineMath(draft);
    setLines((prev) => [...prev, { ...draft, math, error }]);
  }

  function updateLine(draftId: string, patch: Partial<Omit<LineDraft, "math" | "error">>) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.draftId !== draftId) return l;
        const merged = { ...l, ...patch };
        const { math, error } = buildLineMath(merged);
        return { ...merged, math, error };
      }),
    );
  }

  function removeLine(draftId: string) {
    setLines((prev) => prev.filter((l) => l.draftId !== draftId));
  }

  // ---- Totals (only counts valid lines) ----
  const totals = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    let total = 0;
    for (const l of lines) {
      if (l.math) {
        subtotal += l.math.lineSubtotalExclVatCents;
        vat += l.math.lineVatCents;
        total += l.math.lineTotalInclVatCents;
      }
    }
    return { subtotal, vat, total };
  }, [lines]);

  // ---- Validation ----
  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (lines.length === 0) errs.push("Add at least one line.");
    if (purchaseType === "normal" && !supplier) {
      errs.push("Pick a supplier (or switch to Opening stock).");
    }
    if (!purchaseDate) errs.push("Purchase date is required.");
    const invalidLines = lines.filter((l) => !l.math).length;
    if (invalidLines > 0) errs.push(`${invalidLines} line(s) have errors.`);
    return errs;
  }, [lines, purchaseType, supplier, purchaseDate]);

  async function handlePost() {
    setSubmitError(null);
    if (validationErrors.length > 0) {
      setSubmitError(validationErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const linePayloads: PostPurchaseLineInput[] = lines.map((l) => {
        const uom = l.product.uoms.find((u) => u.id === l.selectedUomId)!;
        const m = l.math!;
        return {
          purchaseItemId: newId(),
          productId: l.product.id,
          productNameSnapshot: l.product.name,
          productSkuSnapshot: l.product.sku,
          productUomIdSnapshot: uom.id,
          uomCodeSnapshot: uom.uomCode,
          factorNumSnapshot: uom.factor.num,
          factorDenSnapshot: uom.factor.den,
          quantityInUom: m.quantityInUom,
          quantityBase: m.quantityBase,
          unitCostExclVatInUomCents: m.unitCostExclVatInUomCents,
          unitCostInclVatInUomCents: m.unitCostInclVatInUomCents,
          unitCostExclVatBaseCents: m.unitCostExclVatBaseCents,
          unitCostInclVatBaseCents: m.unitCostInclVatBaseCents,
          vatRateIdSnapshot: l.product.vatRateId,
          vatRateBpsSnapshot: l.product.vatRate.rateBps,
          lineSubtotalExclVatCents: m.lineSubtotalExclVatCents,
          lineVatCents: m.lineVatCents,
          lineTotalInclVatCents: m.lineTotalInclVatCents,
        };
      });

      const result = await purchasesRepo.post({
        storeId,
        supplierId: purchaseType === "opening" ? null : supplier?.id ?? null,
        purchaseType,
        supplierReference: supplierReference.trim() || null,
        purchaseDate,
        createdByUserId: userId,
        deviceId: null,
        notes: notes.trim() || null,
        lines: linePayloads,
      });
      onPosted(result.purchaseNumber);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const excludeIds = lines.map((l) => l.product.id);

  return (
    <Card>
      <CardHeader
        title="New purchase"
        subtitle="Record stock received from a supplier — or opening stock for new products."
        actions={
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {/* Type toggle */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-700">Type:</span>
          <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 shadow-sm">
            <button
              type="button"
              onClick={() => setPurchaseType("normal")}
              className={clsx(
                "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                purchaseType === "normal"
                  ? "bg-brand text-brand-fg"
                  : "text-slate-600 hover:bg-slate-50",
              )}
            >
              Normal (supplier)
            </button>
            <button
              type="button"
              onClick={() => {
                setPurchaseType("opening");
                setSupplier(null);
              }}
              className={clsx(
                "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                purchaseType === "opening"
                  ? "bg-brand text-brand-fg"
                  : "text-slate-600 hover:bg-slate-50",
              )}
            >
              Opening stock
            </button>
          </div>
        </div>

        {/* Header fields */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className={clsx(purchaseType === "opening" && "opacity-50")}>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Supplier {purchaseType === "normal" && "*"}
            </label>
            <SupplierPicker
              storeId={storeId}
              value={supplier}
              onChange={setSupplier}
              disabled={purchaseType === "opening"}
            />
          </div>
          <Input
            label="Supplier reference"
            placeholder="Invoice / BoL number"
            value={supplierReference}
            onChange={(e) => setSupplierReference(e.target.value)}
          />
          <Input
            type="date"
            label="Purchase date *"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
          />
        </div>

        {/* Line builder */}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Add a product
            </label>
            <ProductPicker
              storeId={storeId}
              onPick={addLine}
              excludeIds={excludeIds}
            />
          </div>

          {lines.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">UoM</th>
                    <th className="px-3 py-2 font-medium">Qty</th>
                    <th className="px-3 py-2 font-medium">Unit cost</th>
                    <th className="px-3 py-2 font-medium">Cost mode</th>
                    <th className="px-3 py-2 font-medium text-right">Subtotal</th>
                    <th className="px-3 py-2 font-medium text-right">VAT</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((l) => (
                    <LineRow
                      key={l.draftId}
                      line={l}
                      onUpdate={(patch) => updateLine(l.draftId, patch)}
                      onRemove={() => removeLine(l.draftId)}
                    />
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 text-sm">
                  <tr>
                    <td className="px-3 py-2 text-right font-medium text-slate-700" colSpan={5}>
                      Totals
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">
                      {formatUsd(totals.subtotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">
                      {formatUsd(totals.vat)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-emerald-900">
                      {formatUsd(totals.total)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <Input
          label="Notes (optional)"
          placeholder="Anything worth remembering about this batch"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {submitError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {submitError}
          </div>
        )}
        {!submitError && validationErrors.length > 0 && lines.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            {validationErrors[0]}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button
            variant="primary"
            onClick={handlePost}
            disabled={submitting || validationErrors.length > 0}
          >
            {submitting ? "Posting…" : "Post purchase"}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <p className="ml-auto text-xs text-slate-500">
            Posting is atomic — all lines succeed or none do.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Line row
// ============================================================================

function LineRow({
  line,
  onUpdate,
  onRemove,
}: {
  line: LineDraft;
  onUpdate: (patch: Partial<Omit<LineDraft, "math" | "error">>) => void;
  onRemove: () => void;
}) {
  const selectedUom = line.product.uoms.find((u) => u.id === line.selectedUomId);
  const product = line.product;

  return (
    <tr className={clsx(line.error && "bg-red-50/40")}>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-slate-900">{product.name}</div>
        <div className="text-xs text-slate-500">
          VAT {formatBps(product.vatRate.rateBps)} · base {product.baseUom.uomCode}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <select
          value={line.selectedUomId}
          onChange={(e) => onUpdate({ selectedUomId: e.target.value })}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
        >
          {product.uoms.map((u) => (
            <option key={u.id} value={u.id}>
              {u.uomCode}
              {u.isBase ? " (base)" : ` (${u.factor.num}/${u.factor.den})`}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 align-top">
        <input
          type="text"
          inputMode="numeric"
          value={line.quantityInput}
          onChange={(e) => onUpdate({ quantityInput: e.target.value })}
          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
        />
        {line.math && selectedUom && !selectedUom.isBase && (
          <div className="mt-0.5 text-[10px] text-slate-500">
            = {line.math.quantityBase} {product.baseUom.uomCode}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex items-center">
          <span className="mr-1 text-xs text-slate-500">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={line.unitCostInput}
            placeholder="0.00"
            onChange={(e) => onUpdate({ unitCostInput: e.target.value })}
            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
          />
        </div>
        {line.math && selectedUom && !selectedUom.isBase && (
          <div className="mt-0.5 text-[10px] text-slate-500">
            {formatUsd(line.math.unitCostExclVatBaseCents)}/{product.baseUom.uomCode} net
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="inline-flex rounded-md border border-slate-300 bg-white text-xs shadow-sm">
          <button
            type="button"
            onClick={() => onUpdate({ costMode: "inclusive" })}
            className={clsx(
              "px-2 py-1",
              line.costMode === "inclusive"
                ? "bg-brand text-brand-fg"
                : "text-slate-600 hover:bg-slate-50",
            )}
          >
            incl.
          </button>
          <button
            type="button"
            onClick={() => onUpdate({ costMode: "exclusive" })}
            className={clsx(
              "px-2 py-1",
              line.costMode === "exclusive"
                ? "bg-brand text-brand-fg"
                : "text-slate-600 hover:bg-slate-50",
            )}
          >
            excl.
          </button>
        </div>
      </td>
      <td className="px-3 py-2 text-right align-top text-slate-700">
        {line.math ? formatUsd(line.math.lineSubtotalExclVatCents) : "—"}
      </td>
      <td className="px-3 py-2 text-right align-top text-slate-700">
        {line.math ? formatUsd(line.math.lineVatCents) : "—"}
      </td>
      <td className="px-3 py-2 text-right align-top font-medium text-slate-900">
        {line.math ? formatUsd(line.math.lineTotalInclVatCents) : "—"}
        {line.error && (
          <div className="mt-0.5 text-[10px] font-normal text-red-600">{line.error}</div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <Button variant="ghost" size="sm" onClick={onRemove}>
          ✕
        </Button>
      </td>
    </tr>
  );
}
