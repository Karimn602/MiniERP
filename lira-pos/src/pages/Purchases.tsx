import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { purchasesRepo, type PostPurchaseLineInput } from "../db/repos/purchases";
import type {
  Purchase,
  PurchaseWithLines,
  PurchaseItem,
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
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { ProductPicker } from "../components/ProductPicker";
import { SupplierPicker } from "../components/SupplierPicker";
import { newId } from "../lib/ids";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

type TFunc = (key: string, vars?: Record<string, string>) => string;

interface LineDraft {
  draftId: string;
  product: ProductWithUoms;
  selectedUomId: string;
  quantityInput: string;
  unitCostInput: string;
  costMode: VatPricingMode;
  math: PurchaseLineMath | null;
  error: string | null;
}

function buildLineMath(
  line: Omit<LineDraft, "math" | "error">,
  t: TFunc,
): {
  math: PurchaseLineMath | null;
  error: string | null;
} {
  const qty = Number(line.quantityInput);

  if (!Number.isInteger(qty) || qty <= 0) {
    return { math: null, error: t("purchases.errQtyPositive") };
  }

  let unitCostCents: number;

  try {
    unitCostCents = parseUsdInput(line.unitCostInput);
  } catch {
    return { math: null, error: t("purchases.errUnitCostInvalid") };
  }

  if (unitCostCents < 0) {
    return { math: null, error: t("purchases.errUnitCostNegative") };
  }

  const uom = line.product.uoms.find((u) => u.id === line.selectedUomId);

  if (!uom) {
    return { math: null, error: t("purchases.errPickUom") };
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

export default function Purchases() {
  const { storeId, userId } = useActiveContext();
  const { t } = useTranslation();

  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [justSaved, setJustSaved] = useState<{ number: number } | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<PurchaseWithLines | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

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

  async function openDetails(id: string) {
    if (selectedId === id && details) {
      setSelectedId(null);
      setDetails(null);
      return;
    }

    setSelectedId(id);
    setDetails(null);
    setDetailsError(null);
    setDetailsLoading(true);

    try {
      const row = await purchasesRepo.findByIdWithLines(id);
      if (!row) throw new Error(t("purchases.purchaseNotFound"));
      setDetails(row);
    } catch (e) {
      setDetailsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailsLoading(false);
    }
  }

  function handlePosted(purchaseNumber: number) {
    setFormOpen(false);
    setJustSaved({ number: purchaseNumber });
    setTimeout(() => setJustSaved(null), 4000);
    void reload();
  }

  if (loading && purchases.length === 0) {
    return <div className="text-sm text-slate-500">{t("purchases.loadingPage")}</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("purchases.title")}
        subtitle={t("purchases.subtitle")}
        actions={
          <div className="flex items-center gap-3">
            {justSaved && (
              <span className="text-sm font-medium text-emerald-600">
                {t("purchases.postedSuccess", { number: String(justSaved.number) })}
              </span>
            )}

            <Button
              variant={formOpen ? "ghost" : "primary"}
              onClick={() => setFormOpen((o) => !o)}
            >
              {formOpen ? t("purchases.closeForm") : t("purchases.newPurchase")}
            </Button>
          </div>
        }
      />

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
          title={t("purchases.listTitle")}
          subtitle={
            loading
              ? t("common.loading")
              : purchases.length === 1
                ? t("purchases.countOne", { count: "1" })
                : t("purchases.countMany", { count: String(purchases.length) })
          }
        />

        {loadError ? (
          <CardBody>
            <p className="text-sm text-red-700">
              {t("purchases.loadFailed", { error: loadError })}
            </p>
          </CardBody>
        ) : purchases.length === 0 ? (
          <EmptyState title={t("purchases.emptyState")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">{t("purchases.colNum")}</th>
                  <th className="px-5 py-2 font-medium">{t("purchases.colDate")}</th>
                  <th className="px-5 py-2 font-medium">{t("purchases.colType")}</th>
                  <th className="px-5 py-2 font-medium">{t("purchases.colReference")}</th>
                  <th className="px-5 py-2 font-medium text-right">
                    {t("purchases.colTotalInclVat")}
                  </th>
                  <th className="px-5 py-2 font-medium">{t("purchases.colStatus")}</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {purchases.map((p) => (
                  <tr
                    key={p.id}
                    className={clsx(
                      "cursor-pointer transition-colors hover:bg-slate-50",
                      selectedId === p.id && "bg-brand/5",
                    )}
                    onClick={() => void openDetails(p.id)}
                  >
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
                        {p.purchaseType === "opening"
                          ? t("purchases.typeOpening")
                          : t("purchases.typeNormal")}
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
                          p.status === "voided" &&
                            "bg-slate-200 text-slate-600 line-through",
                        )}
                      >
                        {p.status === "posted"
                          ? t("purchases.statusPosted")
                          : p.status === "draft"
                            ? t("purchases.statusDraft")
                            : t("purchases.statusVoided")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId && (
        <>
          <div
            className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-sm"
            onClick={() => {
              setSelectedId(null);
              setDetails(null);
            }}
          />
          <div className="fixed inset-y-0 end-0 z-50 w-[820px] max-w-[80vw] animate-fade-in overflow-y-auto border-s border-slate-200 bg-white shadow-2xl">
            <PurchaseDetailCard
              purchase={details}
              loading={detailsLoading}
              error={detailsError}
              onClose={() => {
                setSelectedId(null);
                setDetails(null);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

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
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierReference, setSupplierReference] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayLocalDate());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function addLine(product: ProductWithUoms) {
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

    const { math, error } = buildLineMath(draft, t);

    setLines((prev) => [...prev, { ...draft, math, error }]);
  }

  function updateLine(
    draftId: string,
    patch: Partial<Omit<LineDraft, "math" | "error">>,
  ) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.draftId !== draftId) return l;

        const merged = { ...l, ...patch };
        const { math, error } = buildLineMath(merged, t);

        return { ...merged, math, error };
      }),
    );
  }

  function removeLine(draftId: string) {
    setLines((prev) => prev.filter((l) => l.draftId !== draftId));
  }

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

  const validationErrors = useMemo(() => {
    const errs: string[] = [];

    if (lines.length === 0) errs.push(t("purchases.errAtLeastOneLine"));
    if (!supplier) errs.push(t("purchases.errPickSupplier"));
    if (!purchaseDate) errs.push(t("purchases.errDateRequired"));

    const invalidLines = lines.filter((l) => !l.math).length;

    if (invalidLines > 0)
      errs.push(t("purchases.errLineErrors", { count: String(invalidLines) }));

    return errs;
  }, [lines, supplier, purchaseDate, t]);

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
        supplierId: supplier?.id ?? null,
        purchaseType: "normal",
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
        title={t("purchases.formTitle")}
        subtitle={t("purchases.formSubtitle")}
        actions={
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </Button>
        }
      />

      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              {t("purchases.supplierLabel")}
            </label>

            <SupplierPicker
              storeId={storeId}
              value={supplier}
              onChange={setSupplier}
            />
          </div>

          <Input
            label={t("purchases.supplierRef")}
            placeholder={t("purchases.supplierRefPlaceholder")}
            value={supplierReference}
            onChange={(e) => setSupplierReference(e.target.value)}
          />

          <Input
            type="date"
            label={t("purchases.purchaseDateLabel")}
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
          />
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              {t("purchases.addProduct")}
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
                <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("purchases.lineColProduct")}</th>
                    <th className="px-3 py-2 font-medium">{t("purchases.lineColUom")}</th>
                    <th className="px-3 py-2 font-medium">{t("purchases.lineColQty")}</th>
                    <th className="px-3 py-2 font-medium">{t("purchases.lineColUnitCost")}</th>
                    <th className="px-3 py-2 font-medium">{t("purchases.lineColCostMode")}</th>
                    <th className="px-3 py-2 font-medium text-right">{t("purchases.lineColSubtotal")}</th>
                    <th className="px-3 py-2 font-medium text-right">{t("purchases.lineColVat")}</th>
                    <th className="px-3 py-2 font-medium text-right">{t("purchases.lineColTotal")}</th>
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
                    <td
                      className="px-3 py-2 text-right font-medium text-slate-700"
                      colSpan={5}
                    >
                      {t("purchases.totalsLabel")}
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
          label={t("purchases.notesLabel")}
          placeholder={t("purchases.notesPlaceholder")}
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
            {submitting ? t("purchases.posting") : t("purchases.postPurchase")}
          </Button>

          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </Button>

          <p className="ml-auto text-xs text-slate-500">
            {t("purchases.atomicNote")}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-xs font-medium text-slate-800">{value}</span>
    </div>
  );
}

function PurchaseLinesTable({ lines }: { lines: PurchaseItem[] }) {
  const { t } = useTranslation();

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">{t("purchases.linesColProduct")}</th>
            <th className="px-4 py-2">{t("purchases.linesColSku")}</th>
            <th className="px-4 py-2">{t("purchases.linesColBarcode")}</th>
            <th className="px-4 py-2">{t("purchases.linesColUom")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColQty")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColUnitCostExcl")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColUnitCostIncl")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColSubtotalExcl")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColVat")}</th>
            <th className="px-4 py-2 text-right">{t("purchases.linesColTotal")}</th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="px-4 py-2">
                <div className="font-medium text-slate-900">
                  {line.productNameSnapshot}
                </div>
                <div className="text-xs text-slate-500">
                  {t("purchases.vatPercent", {
                    pct: (line.vatRateBpsSnapshot / 100).toFixed(0),
                  })}
                </div>
              </td>

              <td className="px-4 py-2 text-xs text-slate-600">
                {line.productSkuSnapshot ?? "—"}
              </td>

              <td className="px-4 py-2 text-xs text-slate-400">—</td>

              <td className="px-4 py-2 text-xs text-slate-600">
                {line.uomCodeSnapshot}
              </td>

              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {line.quantityInUom}
              </td>

              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {formatUsd(line.unitCostExclVatInUomCents)}
              </td>

              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {formatUsd(line.unitCostInclVatInUomCents)}
              </td>

              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {formatUsd(line.lineSubtotalExclVatCents)}
              </td>

              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {formatUsd(line.lineVatCents)}
              </td>

              <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900">
                {formatUsd(line.lineTotalInclVatCents)}
              </td>
            </tr>
          ))}
        </tbody>
    </table>
    </div>
  );
}

function PurchaseDetailCard({
  purchase,
  loading,
  error,
  onClose,
}: {
  purchase: PurchaseWithLines | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader
        title={
          purchase
            ? t("purchases.detailTitle", { number: String(purchase.purchaseNumber) })
            : t("purchases.detailFallbackTitle")
        }
        subtitle={
          purchase?.postedAt
            ? t("purchases.detailPostedAt", {
                date: formatPrettyDate(purchase.postedAt.slice(0, 10)),
              })
            : undefined
        }
        actions={
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        }
      />

      <CardBody className="space-y-5">
        {loading ? (
          <p className="text-sm text-slate-500">{t("purchases.detailLoadingMsg")}</p>
        ) : error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : purchase ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">
                  {t("purchases.detailPurchaseInfo")}
                </div>

                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">{t("purchases.detailType")}</span>
                  <span
                    className={clsx(
                      "rounded px-2 py-0.5 text-xs font-medium",
                      purchase.purchaseType === "opening"
                        ? "bg-indigo-100 text-indigo-700"
                        : "bg-slate-100 text-slate-700",
                    )}
                  >
                    {purchase.purchaseType === "opening"
                      ? t("purchases.typeOpening")
                      : t("purchases.typeNormal")}
                  </span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">{t("purchases.detailStatus")}</span>
                  <span
                    className={clsx(
                      "rounded px-2 py-0.5 text-xs font-medium",
                      purchase.status === "posted" &&
                        "bg-emerald-100 text-emerald-800",
                      purchase.status === "draft" &&
                        "bg-amber-100 text-amber-800",
                      purchase.status === "voided" &&
                        "bg-slate-200 text-slate-600 line-through",
                    )}
                  >
                    {purchase.status === "posted"
                      ? t("purchases.statusPosted")
                      : purchase.status === "draft"
                        ? t("purchases.statusDraft")
                        : t("purchases.statusVoided")}
                  </span>
                </div>

                <DetailRow
                  label={t("purchases.detailSupplier")}
                  value={purchase.supplier?.name ?? "—"}
                />
                <DetailRow
                  label={t("purchases.detailReference")}
                  value={purchase.supplierReference ?? "—"}
                />
                <DetailRow
                  label={t("purchases.detailDate")}
                  value={formatPrettyDate(purchase.purchaseDate)}
                />
                <DetailRow
                  label={t("purchases.detailNotes")}
                  value={purchase.notes ?? "—"}
                />
              </div>

              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">
                  {t("purchases.detailTotals")}
                </div>
                <DetailRow
                  label={t("purchases.detailSubtotalExcl")}
                  value={formatUsd(purchase.subtotalExclVatCents)}
                />
                <DetailRow
                  label={t("purchases.detailVat")}
                  value={formatUsd(purchase.vatTotalCents)}
                />
                <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
                  <span className="text-xs font-semibold text-slate-700">
                    {t("purchases.detailTotalIncl")}
                  </span>
                  <span className="text-right text-sm font-semibold text-slate-900">
                    {formatUsd(purchase.totalInclVatCents)}
                  </span>
                </div>
              </div>
            </div>

            <PurchaseLinesTable lines={purchase.lines} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function LineRow({
  line,
  onUpdate,
  onRemove,
}: {
  line: LineDraft;
  onUpdate: (patch: Partial<Omit<LineDraft, "math" | "error">>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const selectedUom = line.product.uoms.find((u) => u.id === line.selectedUomId);
  const product = line.product;

  return (
    <tr className={clsx(line.error && "bg-red-50/40")}>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-slate-900">{product.name}</div>

        <div className="text-xs text-slate-500">
          {t("purchases.vatBaseLabel", {
            vat: formatBps(product.vatRate.rateBps),
            uom: product.baseUom.uomCode,
          })}
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
              {u.isBase
                ? ` ${t("purchases.uomBase")}`
                : ` (${u.factor.num}/${u.factor.den})`}
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
            {t("purchases.inclLabel")}
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
            {t("purchases.exclLabel")}
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
          <div className="mt-0.5 text-[10px] font-normal text-red-600">
            {line.error}
          </div>
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
