import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo } from "../db/repos/products";
import { movementsRepo } from "../db/repos/movements";
import { purchasesRepo, type PostPurchaseLineInput } from "../db/repos/purchases";
import type {
  InventoryMovement,
  MovementType,
  ProductWithUoms,
  ProductUom,
  VatPricingMode,
} from "../db/types";
import { formatUsd, parseUsdInput } from "../lib/money";
import { toBaseQty } from "../lib/uom";
import { todayLocalDate } from "../lib/dates";
import { computeLineMath, type PurchaseLineMath } from "../lib/purchaseMath";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProductPicker } from "../components/ProductPicker";
import { newId } from "../lib/ids";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";

type View = "stock" | "movements" | "adjust" | "opening";

export default function Inventory() {
  const { storeId, userId } = useActiveContext();
  const [view, setView] = useState<View>("stock");
  const [searchParams, setSearchParams] = useSearchParams();

  // Honor ?drill=<productId> from incoming links (e.g. Purchases page).
  // We hand the ID to StockView via prop; clear the param so the drawer
  // doesn't reopen on every interaction.
  const drillProductId = searchParams.get("drill");
  useEffect(() => {
    if (drillProductId) setView("stock");
  }, [drillProductId]);

  function clearDrill() {
    if (searchParams.has("drill")) {
      searchParams.delete("drill");
      setSearchParams(searchParams, { replace: true });
    }
  }

  if (!storeId) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Inventory</h2>
          <p className="text-sm text-slate-600">
            Current stock levels, the movement ledger, manual adjustments, and opening stock.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 shadow-sm">
          {(["stock", "movements", "adjust", "opening"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                clearDrill();
              }}
              className={clsx(
                "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                view === v
                  ? "bg-brand text-brand-fg"
                  : "text-slate-600 hover:bg-slate-50",
              )}
            >
              {v === "stock"
                ? "Stock"
                : v === "movements"
                  ? "Movements"
                  : v === "adjust"
                    ? "Adjust"
                    : "Opening"}
            </button>
          ))}
        </div>
      </div>

      {view === "stock" && (
        <StockView
          storeId={storeId}
          drillProductId={drillProductId}
          onCloseDrill={clearDrill}
        />
      )}
      {view === "movements" && <MovementsView storeId={storeId} />}
      {view === "adjust" && <AdjustView storeId={storeId} userId={userId} />}
      {view === "opening" && <OpeningStockView storeId={storeId} userId={userId} />}
    </div>
  );
}

// ============================================================================
// Stock view
// ============================================================================

function StockView({
  storeId,
  drillProductId,
  onCloseDrill,
}: {
  storeId: string;
  drillProductId: string | null;
  onCloseDrill: () => void;
}) {
  const [rows, setRows] = useState<ProductWithUoms[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [drillProduct, setDrillProduct] = useState<ProductWithUoms | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await productsRepo.listEnriched({
        storeId,
        search: search.trim() || undefined,
        limit: 500,
      });
      setRows(list);
      return list;
    } finally {
      setLoading(false);
    }
  }, [storeId, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Open drawer when ?drill=<id> arrives or rows finish loading.
  useEffect(() => {
    if (!drillProductId) return;
    const match = rows.find((r) => r.id === drillProductId);
    if (match) setDrillProduct(match);
  }, [drillProductId, rows]);

  const filtered = useMemo(() => {
    if (!lowOnly) return rows;
    return rows.filter(
      (p) =>
        !p.isService &&
        p.reorderPoint !== null &&
        p.quantityOnHand <= p.reorderPoint,
    );
  }, [rows, lowOnly]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filter" />
        <CardBody className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <Input
              placeholder="Search by name, SKU, or barcode…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
              className="rounded border-slate-300"
            />
            Low stock only (at or below reorder point)
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Stock on hand"
          subtitle={
            loading
              ? "Loading…"
              : `${filtered.length} ${filtered.length === 1 ? "product" : "products"}`
          }
        />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Product</th>
                <th className="px-5 py-2 font-medium text-right">On hand</th>
                <th className="px-5 py-2 font-medium text-right">Reorder pt.</th>
                <th className="px-5 py-2 font-medium text-right">Avg cost (incl)</th>
                <th className="px-5 py-2 font-medium text-right">Stock value</th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-500">
                    {lowOnly ? "Nothing below reorder point." : "No products match."}
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const low =
                    !p.isService &&
                    p.reorderPoint !== null &&
                    p.quantityOnHand <= p.reorderPoint;
                  const stockValue = p.isService
                    ? 0
                    : p.quantityOnHand * p.avgCostInclVatCents;
                  return (
                    <tr
                      key={p.id}
                      className={clsx(
                        "transition-colors hover:bg-slate-50",
                        low && "bg-amber-50/40",
                      )}
                    >
                      <td className="px-5 py-2">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">
                          {p.sku && <span>SKU: {p.sku} · </span>}
                          base {p.baseUom.uomCode}
                          {p.isService && (
                            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-indigo-700">
                              Service
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2 text-right">
                        {p.isService ? (
                          <span className="text-xs text-slate-400">n/a</span>
                        ) : (
                          <span className={clsx("font-medium", low ? "text-amber-700" : "text-slate-900")}>
                            {p.quantityOnHand} {p.baseUom.uomCode}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-right text-xs text-slate-600">
                        {p.reorderPoint ?? "—"}
                      </td>
                      <td className="px-5 py-2 text-right text-slate-700">
                        {p.isService ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          formatUsd(p.avgCostInclVatCents)
                        )}
                      </td>
                      <td className="px-5 py-2 text-right font-medium text-slate-900">
                        {p.isService ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          formatUsd(stockValue)
                        )}
                      </td>
                      <td className="px-5 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDrillProduct(p)}
                        >
                          History →
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {drillProduct && (
        <MovementsDrawer
          product={drillProduct}
          onClose={() => {
            setDrillProduct(null);
            onCloseDrill();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Movements drawer
// ============================================================================

function MovementsDrawer({
  product,
  onClose,
}: {
  product: ProductWithUoms;
  onClose: () => void;
}) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void movementsRepo
      .listForProduct(product.id, 200)
      .then((rows) => !cancelled && setMovements(rows))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {product.name} — movement history
            </h3>
            <p className="text-xs text-slate-500">
              Current stock: {product.quantityOnHand} {product.baseUom.uomCode} ·
              avg cost {formatUsd(product.avgCostInclVatCents)} incl. VAT
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="p-5 text-sm text-slate-500">Loading…</p>
          ) : movements.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">No movements recorded yet for this product.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium text-right">Δ qty</th>
                  <th className="px-4 py-2 font-medium text-right">Unit cost</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2 text-xs text-slate-700">
                      {m.postedAt.replace("T", " ").replace("Z", "").slice(0, 19)}
                    </td>
                    <td className="px-4 py-2">
                      <MovementBadge type={m.movementType} delta={m.quantityDelta} />
                    </td>
                    <td className="px-4 py-2 text-right font-medium">
                      <span className={clsx(m.quantityDelta > 0 ? "text-emerald-700" : "text-red-700")}>
                        {m.quantityDelta > 0 ? "+" : ""}{m.quantityDelta} {product.baseUom.uomCode}
                      </span>
                      {m.quantityInUom !== null &&
                        m.uomCodeSnapshot &&
                        m.uomCodeSnapshot !== product.baseUom.uomCode && (
                          <div className="text-[10px] font-normal text-slate-500">
                            ({m.quantityInUom > 0 ? "+" : ""}{m.quantityInUom} {m.uomCodeSnapshot})
                          </div>
                        )}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-slate-600">
                      {formatUsd(m.unitCostInclVatCents)}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {m.notes ?? m.supplierReference ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// Sharper sign-aware badge (Phase 2D.3).
function MovementBadge({ type, delta }: { type: MovementType; delta: number }) {
  const signed: Partial<Record<MovementType, true>> = {
    adjustment: true,
    return_in: true,
    return_out: true,
    transfer_in: true,
    transfer_out: true,
  };
  if (signed[type]) {
    const positive = delta > 0;
    const label =
      type === "adjustment"
        ? positive ? "adjust +" : "adjust −"
        : type === "return_in" ? "return in"
        : type === "return_out" ? "return out"
        : type === "transfer_in" ? "xfer in"
        : "xfer out";
    return (
      <span
        className={clsx(
          "rounded px-2 py-0.5 text-xs font-medium",
          positive ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800",
        )}
      >
        {label}
      </span>
    );
  }

  const meta: Record<MovementType, { label: string; className: string }> = {
    purchase:     { label: "purchase",   className: "bg-emerald-100 text-emerald-800" },
    opening:      { label: "opening",    className: "bg-indigo-100 text-indigo-800" },
    sale:         { label: "sale",       className: "bg-blue-100 text-blue-800" },
    return_in:    { label: "return in",  className: "bg-teal-100 text-teal-800" },
    return_out:   { label: "return out", className: "bg-orange-100 text-orange-800" },
    adjustment:   { label: "adjust",     className: "bg-amber-100 text-amber-800" },
    transfer_in:  { label: "xfer in",    className: "bg-slate-200 text-slate-700" },
    transfer_out: { label: "xfer out",   className: "bg-slate-200 text-slate-700" },
  };
  const m = meta[type];
  return <span className={clsx("rounded px-2 py-0.5 text-xs font-medium", m.className)}>{m.label}</span>;
}

// ============================================================================
// Movements ledger view
// ============================================================================

function MovementsView({ storeId }: { storeId: string }) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [products, setProducts] = useState<Map<string, ProductWithUoms>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MovementType | "all">("all");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [movs, prods] = await Promise.all([
        movementsRepo.listRecent({
          storeId,
          movementType: filter === "all" ? undefined : filter,
          limit: 300,
        }),
        productsRepo.listEnriched({ storeId, includeInactive: true, limit: 500 }),
      ]);
      setMovements(movs);
      setProducts(new Map(prods.map((p) => [p.id, p])));
    } finally {
      setLoading(false);
    }
  }, [storeId, filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card>
      <CardHeader
        title="Recent movements"
        subtitle={loading ? "Loading…" : `${movements.length} entries`}
        actions={
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as MovementType | "all")}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
          >
            <option value="all">All types</option>
            <option value="purchase">Purchase</option>
            <option value="opening">Opening</option>
            <option value="adjustment">Adjustment</option>
            <option value="sale">Sale</option>
            <option value="return_in">Return in</option>
            <option value="return_out">Return out</option>
          </select>
        }
      />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-2 font-medium">When</th>
              <th className="px-5 py-2 font-medium">Type</th>
              <th className="px-5 py-2 font-medium">Product</th>
              <th className="px-5 py-2 font-medium text-right">Δ qty</th>
              <th className="px-5 py-2 font-medium text-right">Unit cost</th>
              <th className="px-5 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {movements.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-500">
                  No movements recorded yet.
                </td>
              </tr>
            ) : (
              movements.map((m) => {
                const p = products.get(m.productId);
                return (
                  <tr key={m.id}>
                    <td className="px-5 py-2 text-xs text-slate-700">
                      {m.postedAt.replace("T", " ").replace("Z", "").slice(0, 19)}
                    </td>
                    <td className="px-5 py-2">
                      <MovementBadge type={m.movementType} delta={m.quantityDelta} />
                    </td>
                    <td className="px-5 py-2">
                      <div className="font-medium text-slate-900">
                        {p?.name ?? <code className="text-xs">{m.productId.slice(0, 8)}</code>}
                      </div>
                      {p && <div className="text-[10px] text-slate-500">{p.sku ?? "—"}</div>}
                    </td>
                    <td className="px-5 py-2 text-right font-medium">
                      <span className={clsx(m.quantityDelta > 0 ? "text-emerald-700" : "text-red-700")}>
                        {m.quantityDelta > 0 ? "+" : ""}{m.quantityDelta} {p?.baseUom.uomCode ?? ""}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right text-xs text-slate-600">
                      {formatUsd(m.unitCostInclVatCents)}
                    </td>
                    <td className="px-5 py-2 text-xs text-slate-600">
                      {m.notes ?? m.supplierReference ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ============================================================================
// Adjustments
// ============================================================================

interface AdjLineDraft {
  draftId: string;
  product: ProductWithUoms;
  selectedUomId: string;
  direction: "+" | "-";
  quantityInput: string;
  quantityInUomSigned: number | null;
  quantityBaseSigned: number | null;
  error: string | null;
}

function computeAdjLine(
  partial: Omit<AdjLineDraft, "quantityInUomSigned" | "quantityBaseSigned" | "error">,
): { quantityInUomSigned: number | null; quantityBaseSigned: number | null; error: string | null } {
  const uom = partial.product.uoms.find((u) => u.id === partial.selectedUomId);
  if (!uom) return { quantityInUomSigned: null, quantityBaseSigned: null, error: "Pick a UoM." };
  const magnitude = Number(partial.quantityInput);
  if (!Number.isInteger(magnitude) || magnitude <= 0) {
    return { quantityInUomSigned: null, quantityBaseSigned: null, error: "Whole positive number." };
  }
  const sign = partial.direction === "+" ? 1 : -1;
  const baseMagnitude = toBaseQty(magnitude, uom.factor);
  if (sign === -1 && partial.product.quantityOnHand - baseMagnitude < 0) {
    return {
      quantityInUomSigned: null,
      quantityBaseSigned: null,
      error: `Only ${partial.product.quantityOnHand} ${partial.product.baseUom.uomCode} on hand.`,
    };
  }
  return {
    quantityInUomSigned: sign * magnitude,
    quantityBaseSigned: sign * baseMagnitude,
    error: null,
  };
}

function AdjustView({ storeId, userId }: { storeId: string; userId: string | null }) {
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<AdjLineDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  function addLine(product: ProductWithUoms) {
    const uom = product.defaultSaleUom ?? product.baseUom;
    const partial: Omit<AdjLineDraft, "quantityInUomSigned" | "quantityBaseSigned" | "error"> = {
      draftId: newId(),
      product,
      selectedUomId: uom.id,
      direction: "+",
      quantityInput: "1",
    };
    const computed = computeAdjLine(partial);
    setLines((prev) => [...prev, { ...partial, ...computed }]);
  }

  function updateLine(draftId: string, patch: Partial<AdjLineDraft>) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.draftId !== draftId) return l;
        const merged = { ...l, ...patch };
        const computed = computeAdjLine(merged);
        return { ...merged, ...computed };
      }),
    );
  }

  function removeLine(draftId: string) {
    setLines((prev) => prev.filter((l) => l.draftId !== draftId));
  }

  const validationError = useMemo<string | null>(() => {
    if (!reason.trim()) return "Reason is required.";
    if (lines.length === 0) return "Add at least one line.";
    const bad = lines.find((l) => l.error || l.quantityBaseSigned === null);
    if (bad) return bad.error ?? "Fix line errors before posting.";
    return null;
  }, [reason, lines]);

  async function handlePost() {
    setSubmitError(null);
    if (validationError) {
      setSubmitError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      await movementsRepo.postAdjustment({
        storeId,
        createdByUserId: userId,
        deviceId: null,
        reason: reason.trim(),
        lines: lines.map((l) => {
          const uom = l.product.uoms.find((u) => u.id === l.selectedUomId)!;
          return {
            productId: l.product.id,
            uomCodeSnapshot: uom.uomCode,
            factorNumSnapshot: uom.factor.num,
            factorDenSnapshot: uom.factor.den,
            quantityInUomSigned: l.quantityInUomSigned!,
            quantityBaseSigned: l.quantityBaseSigned!,
          };
        }),
      });
      setLines([]);
      setReason("");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Manual adjustment"
        subtitle="Record shrinkage, breakage, count corrections. Adjustments do not change weighted-average cost."
      />
      <CardBody className="space-y-4">
        <Input
          label="Reason *"
          placeholder="e.g. Monthly count correction, breakage, theft, expired stock"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Add a product</label>
          <ProductPicker
            storeId={storeId}
            onPick={addLine}
            excludeIds={lines.map((l) => l.product.id)}
          />
        </div>

        {lines.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">UoM</th>
                  <th className="px-3 py-2 font-medium">+ / −</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium text-right">Δ in base</th>
                  <th className="px-3 py-2 font-medium text-right">After</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const after = l.quantityBaseSigned !== null
                    ? l.product.quantityOnHand + l.quantityBaseSigned
                    : null;
                  return (
                    <tr key={l.draftId} className={clsx(l.error && "bg-red-50/40")}>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-slate-900">{l.product.name}</div>
                        <div className="text-xs text-slate-500">
                          Current: {l.product.quantityOnHand} {l.product.baseUom.uomCode}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <select
                          value={l.selectedUomId}
                          onChange={(e) => updateLine(l.draftId, { selectedUomId: e.target.value })}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
                        >
                          {l.product.uoms.map((u) => (
                            <option key={u.id} value={u.id}>{u.uomCode}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="inline-flex rounded-md border border-slate-300 bg-white text-xs shadow-sm">
                          <button
                            type="button"
                            onClick={() => updateLine(l.draftId, { direction: "+" })}
                            className={clsx(
                              "px-2 py-1",
                              l.direction === "+" ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-50",
                            )}
                          >+</button>
                          <button
                            type="button"
                            onClick={() => updateLine(l.draftId, { direction: "-" })}
                            className={clsx(
                              "px-2 py-1",
                              l.direction === "-" ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50",
                            )}
                          >−</button>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={l.quantityInput}
                          onChange={(e) => updateLine(l.draftId, { quantityInput: e.target.value })}
                          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
                        />
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        {l.quantityBaseSigned !== null ? (
                          <span className={clsx("font-medium", l.quantityBaseSigned > 0 ? "text-emerald-700" : "text-red-700")}>
                            {l.quantityBaseSigned > 0 ? "+" : ""}{l.quantityBaseSigned} {l.product.baseUom.uomCode}
                          </span>
                        ) : (<span className="text-xs text-slate-400">—</span>)}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        {after !== null ? (
                          <span className="text-slate-700">{after} {l.product.baseUom.uomCode}</span>
                        ) : (<span className="text-xs text-slate-400">—</span>)}
                        {l.error && (<div className="mt-0.5 text-[10px] text-red-600">{l.error}</div>)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Button variant="ghost" size="sm" onClick={() => removeLine(l.draftId)}>✕</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {submitError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {submitError}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button variant="primary" onClick={handlePost} disabled={submitting || validationError !== null}>
            {submitting ? "Posting…" : "Post adjustment"}
          </Button>
          {justSaved && <span className="text-sm text-emerald-700">✓ Adjustment posted</span>}
          <p className="ml-auto text-xs text-slate-500">
            Adjustments are append-only. Mistakes are fixed by posting another adjustment.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Opening stock (Phase 2D.4) — same posting code path as Purchases, no supplier
// ============================================================================

interface OpeningLineDraft {
  draftId: string;
  product: ProductWithUoms;
  selectedUomId: string;
  quantityInput: string;
  unitCostInput: string;
  costMode: VatPricingMode;
  math: PurchaseLineMath | null;
  error: string | null;
}

function buildOpeningLineMath(line: Omit<OpeningLineDraft, "math" | "error">): {
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
  if (!uom) return { math: null, error: "Pick a UoM." };
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
    return { math: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function OpeningStockView({ storeId, userId }: { storeId: string; userId: string | null }) {
  const [openingDate, setOpeningDate] = useState(todayLocalDate());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<OpeningLineDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<{ number: number } | null>(null);

  function addLine(product: ProductWithUoms) {
    const uom: ProductUom =
      product.uoms.find((u) => u.isDefaultPurchase) ??
      product.defaultSaleUom ??
      product.baseUom;
    const draft: Omit<OpeningLineDraft, "math" | "error"> = {
      draftId: newId(),
      product,
      selectedUomId: uom.id,
      quantityInput: "1",
      unitCostInput: "",
      costMode: product.vatPricingMode,
    };
    const { math, error } = buildOpeningLineMath(draft);
    setLines((prev) => [...prev, { ...draft, math, error }]);
  }

  function updateLine(draftId: string, patch: Partial<Omit<OpeningLineDraft, "math" | "error">>) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.draftId !== draftId) return l;
        const merged = { ...l, ...patch };
        const { math, error } = buildOpeningLineMath(merged);
        return { ...merged, math, error };
      }),
    );
  }

  function removeLine(draftId: string) {
    setLines((prev) => prev.filter((l) => l.draftId !== draftId));
  }

  const totals = useMemo(() => {
    let subtotal = 0, vat = 0, total = 0;
    for (const l of lines) {
      if (l.math) {
        subtotal += l.math.lineSubtotalExclVatCents;
        vat += l.math.lineVatCents;
        total += l.math.lineTotalInclVatCents;
      }
    }
    return { subtotal, vat, total };
  }, [lines]);

  const validationError = useMemo<string | null>(() => {
    if (lines.length === 0) return "Add at least one line.";
    if (!openingDate) return "Date is required.";
    const bad = lines.find((l) => !l.math);
    if (bad) return bad.error;
    return null;
  }, [lines, openingDate]);

  async function handlePost() {
    setSubmitError(null);
    if (validationError) {
      setSubmitError(validationError);
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
        supplierId: null,
        purchaseType: "opening",
        supplierReference: null,
        purchaseDate: openingDate,
        createdByUserId: userId,
        deviceId: null,
        notes: notes.trim() || "Opening stock",
        lines: linePayloads,
      });
      setLines([]);
      setNotes("");
      setJustSaved({ number: result.purchaseNumber });
      setTimeout(() => setJustSaved(null), 4000);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Opening stock"
        subtitle="Record the stock you already had when you started using Lira POS. Creates a purchase document marked 'opening' — no supplier required."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            type="date"
            label="Opening date *"
            value={openingDate}
            onChange={(e) => setOpeningDate(e.target.value)}
          />
          <Input
            label="Notes (optional)"
            placeholder="e.g. Initial count Jan 2025"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Add a product</label>
          <ProductPicker
            storeId={storeId}
            onPick={addLine}
            excludeIds={lines.map((l) => l.product.id)}
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
                  <th className="px-3 py-2 font-medium text-right">Total</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const uom = l.product.uoms.find((u) => u.id === l.selectedUomId);
                  return (
                    <tr key={l.draftId} className={clsx(l.error && "bg-red-50/40")}>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-slate-900">{l.product.name}</div>
                        <div className="text-xs text-slate-500">
                          Currently: {l.product.quantityOnHand} {l.product.baseUom.uomCode}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <select
                          value={l.selectedUomId}
                          onChange={(e) => updateLine(l.draftId, { selectedUomId: e.target.value })}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
                        >
                          {l.product.uoms.map((u) => (
                            <option key={u.id} value={u.id}>{u.uomCode}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={l.quantityInput}
                          onChange={(e) => updateLine(l.draftId, { quantityInput: e.target.value })}
                          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
                        />
                        {l.math && uom && !uom.isBase && (
                          <div className="mt-0.5 text-[10px] text-slate-500">
                            = {l.math.quantityBase} {l.product.baseUom.uomCode}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-center">
                          <span className="mr-1 text-xs text-slate-500">$</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={l.unitCostInput}
                            placeholder="0.00"
                            onChange={(e) => updateLine(l.draftId, { unitCostInput: e.target.value })}
                            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="inline-flex rounded-md border border-slate-300 bg-white text-xs shadow-sm">
                          <button
                            type="button"
                            onClick={() => updateLine(l.draftId, { costMode: "inclusive" })}
                            className={clsx(
                              "px-2 py-1",
                              l.costMode === "inclusive" ? "bg-brand text-brand-fg" : "text-slate-600 hover:bg-slate-50",
                            )}
                          >incl.</button>
                          <button
                            type="button"
                            onClick={() => updateLine(l.draftId, { costMode: "exclusive" })}
                            className={clsx(
                              "px-2 py-1",
                              l.costMode === "exclusive" ? "bg-brand text-brand-fg" : "text-slate-600 hover:bg-slate-50",
                            )}
                          >excl.</button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right align-top font-medium text-slate-900">
                        {l.math ? formatUsd(l.math.lineTotalInclVatCents) : "—"}
                        {l.error && (
                          <div className="mt-0.5 text-[10px] font-normal text-red-600">{l.error}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Button variant="ghost" size="sm" onClick={() => removeLine(l.draftId)}>✕</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 text-sm">
                <tr>
                  <td className="px-3 py-2 text-right font-medium text-slate-700" colSpan={5}>Total stock value</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-900">
                    {formatUsd(totals.total)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {submitError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{submitError}</div>
        )}

        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button variant="primary" onClick={handlePost} disabled={submitting || validationError !== null}>
            {submitting ? "Posting…" : "Post opening stock"}
          </Button>
          {justSaved && (
            <span className="text-sm text-emerald-700">✓ Opening batch #{justSaved.number} posted</span>
          )}
          <p className="ml-auto text-xs text-slate-500">
            Creates a "purchase" document marked opening — appears in Purchases list with the opening badge.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
