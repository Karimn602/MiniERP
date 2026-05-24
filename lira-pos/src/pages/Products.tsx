import { useEffect, useState, useMemo, useCallback } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo, DuplicateSkuError } from "../db/repos/products";
import { vatRatesRepo } from "../db/repos/vatRates";
import { uomsRepo } from "../db/repos/uoms";
import { ProductImportDialog } from "../components/ProductImportDialog";
import type {
  ProductWithUoms,
  VatRate,
  UnitOfMeasure,
} from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { BarcodeManager } from "../components/BarcodeManager";
import { formatUsd, parseUsdInput } from "../lib/money";
import { addVat, stripVat } from "../lib/vat";
import { classifyBarcode as inferBarcodeType, isValidEan13 } from "../lib/barcode";
import { gcd, makeFactor, type Factor } from "../lib/uom";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

type ProductMode = "new" | "edit";

interface ProductFormState {
  mode: ProductMode;
  id: string | null;

  name: string;
  sku: string;
  description: string;

  barcode: string;

  vatRateId: string;
  vatPricingMode: "inclusive" | "exclusive";
  priceInput: string;

  reorderPointInput: string;

  baseUomCode: string;
  saleUomCode: string;
  saleFactorNum: string;
  saleFactorDen: string;
  salePriceInput: string;

  isService: boolean;
  isActive: boolean;
}

const EMPTY_FORM: ProductFormState = {
  mode: "new",
  id: null,

  name: "",
  sku: "",
  description: "",

  barcode: "",

  vatRateId: "",
  vatPricingMode: "inclusive",
  priceInput: "",

  reorderPointInput: "",

  baseUomCode: "pcs",
  saleUomCode: "pcs",
  saleFactorNum: "1",
  saleFactorDen: "1",
  salePriceInput: "",

  isService: false,
  isActive: true,
};

function toIntInput(v: string, fallback = 0): number {
  const trimmed = v.trim();
  if (trimmed === "") return fallback;

  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error("Expected a whole number.");
  }

  return n;
}

function validateFactor(num: number, den: number): Factor {
  if (num <= 0 || den <= 0) {
    throw new Error("UoM factor must be positive.");
  }

  const g = gcd(num, den);
  return makeFactor(num / g, den / g);
}

function vatBpsFor(vatRates: VatRate[], id: string): number {
  return vatRates.find((v) => v.id === id)?.rateBps ?? 0;
}

function splitInclVat(inclVatCents: number, rateBps: number) {
  const exclVatCents = stripVat(inclVatCents, rateBps);
  return {
    exclVatCents,
    vatCents: inclVatCents - exclVatCents,
    inclVatCents,
  };
}

function splitExclVat(exclVatCents: number, rateBps: number) {
  const inclVatCents = addVat(exclVatCents, rateBps);
  return {
    exclVatCents,
    vatCents: inclVatCents - exclVatCents,
    inclVatCents,
  };
}

function getProductPriceDisplay(p: ProductWithUoms): string {
  return formatUsd(p.priceInclVatCents);
}

function getPrimaryBarcodeDisplay(p: ProductWithUoms): string {
  return p.primaryBarcode?.barcode ?? "—";
}

export default function Products() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [products, setProducts] = useState<ProductWithUoms[]>([]);
  const [vatRates, setVatRates] = useState<VatRate[]>([]);
  const [uoms, setUoms] = useState<UnitOfMeasure[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithUoms | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const reload = useCallback(async () => {
    if (!storeId) return;

    setLoading(true);
    setLoadError(null);

    try {
      const [productRows, vatRows, uomRows] = await Promise.all([
        productsRepo.listEnriched({ storeId }),
        vatRatesRepo.listActive(),
        uomsRepo.listActive(),
      ]);

      setProducts(productRows);
      setVatRates(vatRows);
      setUoms(uomRows);

      setForm((prev) => ({
        ...prev,
        vatRateId: prev.vatRateId || vatRows[0]?.id || "",
        baseUomCode: prev.baseUomCode || uomRows[0]?.code || "pcs",
        saleUomCode: prev.saleUomCode || uomRows[0]?.code || "pcs",
      }));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) void reload();
  }, [hydrated, reload]);

  const currentVatBps = useMemo(
    () => vatBpsFor(vatRates, form.vatRateId),
    [vatRates, form.vatRateId],
  );

  const pricePreview = useMemo(() => {
    try {
      if (!form.priceInput.trim()) return null;

      const typed = parseUsdInput(form.priceInput);

      if (form.vatPricingMode === "inclusive") {
        const parts = splitInclVat(typed, currentVatBps);
        return {
          excl: parts.exclVatCents,
          vat: parts.vatCents,
          incl: parts.inclVatCents,
        };
      }

      const parts = splitExclVat(typed, currentVatBps);
      return {
        excl: parts.exclVatCents,
        vat: parts.vatCents,
        incl: parts.inclVatCents,
      };
    } catch {
      return null;
    }
  }, [form.priceInput, form.vatPricingMode, currentVatBps]);

  const filteredProducts = products;

  function resetForm() {
    setForm({
      ...EMPTY_FORM,
      vatRateId: vatRates[0]?.id || "",
      baseUomCode: uoms[0]?.code || "pcs",
      saleUomCode: uoms[0]?.code || "pcs",
    });
    setSelectedProduct(null);
    setSaveError(null);
    setSaveOk(null);
  }

  function closePanel() {
    resetForm();
    setShowForm(false);
  }

  function editProduct(product: ProductWithUoms) {
    setShowForm(true);
    const saleUom = product.defaultSaleUom;
    const baseUom = product.baseUom;

    setSelectedProduct(product);
    setForm({
      mode: "edit",
      id: product.id,

      name: product.name,
      sku: product.sku ?? "",
      description: product.description ?? "",

      barcode: product.primaryBarcode?.barcode ?? "",

      vatRateId: product.vatRateId,
      vatPricingMode: product.vatPricingMode,
      priceInput:
        product.vatPricingMode === "inclusive"
          ? (product.priceInclVatCents / 100).toFixed(2)
          : (product.priceExclVatCents / 100).toFixed(2),

      reorderPointInput:
        product.reorderPoint === null ? "" : String(product.reorderPoint),

      baseUomCode: baseUom.uomCode,
      saleUomCode: saleUom.uomCode,
      saleFactorNum: String(saleUom.factor.num),
      saleFactorDen: String(saleUom.factor.den),
      salePriceInput:
        saleUom.salePriceInclVatCents === null
          ? ""
          : (saleUom.salePriceInclVatCents / 100).toFixed(2),

      isService: product.isService,
      isActive: product.isActive,
    });

    setSaveError(null);
    setSaveOk(null);
  }

  async function handleSave() {
    if (!storeId) return;

    setSaving(true);
    setSaveError(null);
    setSaveOk(null);

    try {
      const name = form.name.trim();
      if (!name) throw new Error(t("products.errNameRequired"));

      let sku = form.sku.trim() || null;
      if (!sku && form.mode === "new") {
        sku = await productsRepo.nextAutoSku(storeId);
      }
      if (!sku) {
        throw new Error(t("products.errSkuRequired"));
      }
      const description = form.description.trim() || null;

      const barcode = form.barcode.trim();

      if (form.mode === "new" && !form.isService && !barcode) {
        throw new Error(t("products.errBarcodeRequired"));
      }

      if (barcode.length === 13 && /^\d+$/.test(barcode) && !isValidEan13(barcode)) {
        throw new Error(t("products.errEan13Invalid"));
      }

      if (!form.vatRateId) throw new Error(t("products.errVatRequired"));
      if (!form.priceInput.trim()) throw new Error(t("products.errPriceRequired"));

      const typedPriceCents = parseUsdInput(form.priceInput);

      const price =
        form.vatPricingMode === "inclusive"
          ? splitInclVat(typedPriceCents, currentVatBps)
          : splitExclVat(typedPriceCents, currentVatBps);

      const avgCostExclVatCents =
        form.mode === "edit" ? (selectedProduct?.avgCostExclVatCents ?? 0) : 0;

      const quantityOnHand = form.isService
        ? 0
        : (form.mode === "edit" ? (selectedProduct?.quantityOnHand ?? 0) : 0);

      const reorderPoint =
        form.reorderPointInput.trim() === ""
          ? null
          : toIntInput(form.reorderPointInput);

      if (reorderPoint !== null && reorderPoint < 0) {
        throw new Error(t("products.errReorderNegative"));
      }

      let factor: Factor;
      try {
        factor = validateFactor(
          toIntInput(form.saleFactorNum, 1),
          toIntInput(form.saleFactorDen, 1),
        );
      } catch {
        throw new Error(t("products.errUomFactor"));
      }

      const salePriceOverrideIncl = form.salePriceInput.trim()
        ? parseUsdInput(form.salePriceInput)
        : null;

      const salePriceOverride =
        salePriceOverrideIncl === null
          ? { exclVatCents: null, inclVatCents: null }
          : {
              exclVatCents: stripVat(salePriceOverrideIncl, currentVatBps),
              inclVatCents: salePriceOverrideIncl,
            };

      if (form.mode === "new") {
        await productsRepo.create({
          storeId,
          sku,
          name,
          description,
          vatRateId: form.vatRateId,
          vatPricingMode: form.vatPricingMode,
          priceExclVatCents: price.exclVatCents,
          priceInclVatCents: price.inclVatCents,
          avgCostExclVatCents,
          avgCostInclVatCents: avgCostExclVatCents,
          quantityOnHand,
          reorderPoint,
          isService: form.isService,
          barcode: barcode || null,
          barcodeType: barcode ? inferBarcodeType(barcode) : null,
          baseUomCode: form.baseUomCode,
          saleUomCode: form.saleUomCode,
          saleFactor: factor,
          salePriceExclVatCents: salePriceOverride.exclVatCents,
          salePriceInclVatCents: salePriceOverride.inclVatCents,
        });

        setSaveOk(t("products.createdOk"));
      } else {
        if (!form.id) throw new Error(t("products.errMissingId"));

        await productsRepo.update(form.id, {
          sku,
          name,
          description,
          vatRateId: form.vatRateId,
          vatPricingMode: form.vatPricingMode,
          priceExclVatCents: price.exclVatCents,
          priceInclVatCents: price.inclVatCents,
          avgCostExclVatCents,
          avgCostInclVatCents: avgCostExclVatCents,
          quantityOnHand,
          reorderPoint,
          isService: form.isService,
          isActive: form.isActive,
        });

        const existingSaleUom = selectedProduct?.uoms.find(
          (u) => u.uomCode === form.saleUomCode,
        );

        if (existingSaleUom) {
          await productsRepo.updateUom(existingSaleUom.id, {
            factor,
            isDefaultSale: true,
            salePriceExclVatCents: salePriceOverride.exclVatCents,
            salePriceInclVatCents: salePriceOverride.inclVatCents,
          });
        } else {
          await productsRepo.addUom({
            productId: form.id,
            uomCode: form.saleUomCode,
            factor,
            isDefaultSale: true,
            isDefaultPurchase: false,
            salePriceExclVatCents: salePriceOverride.exclVatCents,
            salePriceInclVatCents: salePriceOverride.inclVatCents,
          });
        }

        setSaveOk(t("products.updatedOk"));
      }

      await reload();

      if (form.mode === "new") {
        resetForm();
      }
    } catch (e) {
      if (e instanceof DuplicateSkuError) {
        setSaveError(t("products.errSkuDuplicate"));
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("products.loadingPage")}</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">{t("products.title")}</h2>
          <p className="text-sm text-slate-600">{t("products.subtitle")}</p>
        </div>

        <Card>
          <CardHeader
            title={t("products.listTitle")}
            subtitle={
              loading
                ? t("common.loading")
                : filteredProducts.length === 1
                  ? t("products.countOne", { count: String(filteredProducts.length) })
                  : t("products.countMany", { count: String(filteredProducts.length) })
            }
          />

          {loadError && (
            <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
              {t("products.loadFailed", { error: loadError })}
            </div>
          )}

          {filteredProducts.length === 0 && !loading && !loadError ? (
            <div className="px-5 py-8 text-center text-sm text-slate-500">
              {t("products.emptyState")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2">{t("products.colProduct")}</th>
                    <th className="px-5 py-2">{t("products.colBarcode")}</th>
                    <th className="px-5 py-2">{t("products.colVat")}</th>
                    <th className="px-5 py-2 text-right">{t("products.colPrice")}</th>
                    <th className="px-5 py-2 text-right">{t("products.colCost")}</th>
                    <th className="px-5 py-2 text-right">{t("products.colStock")}</th>
                    <th className="px-5 py-2">{t("products.colStatus")}</th>
                    <th className="px-5 py-2"></th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100">
                  {filteredProducts.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-5 py-2">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">
                          {p.sku ? `SKU ${p.sku}` : t("products.noSku")}
                          {p.description ? ` · ${p.description}` : ""}
                        </div>
                      </td>

                      <td className="px-5 py-2">
                        <code className="text-xs text-slate-700">
                          {getPrimaryBarcodeDisplay(p)}
                        </code>
                      </td>

                      <td className="px-5 py-2 text-slate-600">
                        {p.vatRate.name}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-900">
                        {getProductPriceDisplay(p)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                        {formatUsd(p.avgCostExclVatCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {p.isService
                          ? t("products.serviceLabel")
                          : `${p.quantityOnHand} ${p.baseUom.uomCode}`}
                      </td>

                      <td className="px-5 py-2">
                        <span
                          className={clsx(
                            "rounded px-2 py-0.5 text-xs font-medium",
                            p.isActive
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-slate-200 text-slate-600",
                          )}
                        >
                          {p.isActive ? t("products.active") : t("products.inactive")}
                        </span>
                      </td>

                      <td className="px-5 py-2 text-end">
                        <Button variant="ghost" size="sm" onClick={() => editProduct(p)}>
                          {t("common.edit")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div>
        {showForm ? (
        <Card>
          <CardHeader
            title={form.mode === "new" ? t("products.formNewTitle") : t("products.formEditTitle")}
            subtitle={
              form.mode === "new"
                ? t("products.formNewSubtitle")
                : selectedProduct?.name
            }
            actions={
              <Button variant="ghost" size="sm" onClick={closePanel}>
                {t("common.cancel")}
              </Button>
            }
          />

          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-3">
              <Input
                label={t("products.fieldName")}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("products.namePlaceholder")}
              />

              <Input
                label={t("products.fieldSku")}
                value={form.sku}
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                placeholder={form.mode === "new" ? t("products.skuPlaceholderNew") : ""}
              />

              <Input
                label={t("products.fieldDescription")}
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder={t("products.optionalPlaceholder")}
              />

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isService}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      isService: e.target.checked,
                    }))
                  }
                />
                <span>{t("products.serviceItem")}</span>
              </label>

              {form.mode === "edit" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, isActive: e.target.checked }))
                    }
                  />
                  <span>{t("products.activeLabel")}</span>
                </label>
              )}
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                {t("products.barcodeSection")}
              </div>

              {form.mode === "new" ? (
                <Input
                  label={form.isService ? t("products.barcodeLabelOptional") : t("products.barcodeLabel")}
                  value={form.barcode}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, barcode: e.target.value }))
                  }
                  placeholder={t("products.barcodePlaceholder")}
                  hint={
                    form.barcode.length === 13 &&
                    /^\d+$/.test(form.barcode) &&
                    !isValidEan13(form.barcode)
                      ? t("products.barcodeEanHint")
                      : undefined
                  }
                />
              ) : form.id ? (
                <BarcodeManager productId={form.id} />
              ) : null}
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                {t("products.vatSection")}
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-700">
                  {t("products.vatRateLabel")}
                  <select
                    value={form.vatRateId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, vatRateId: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                  >
                    {vatRates.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
                    <input
                      type="radio"
                      checked={form.vatPricingMode === "inclusive"}
                      onChange={() =>
                        setForm((f) => ({ ...f, vatPricingMode: "inclusive" }))
                      }
                    />
                    {t("products.vatInclusive")}
                  </label>

                  <label className="flex items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
                    <input
                      type="radio"
                      checked={form.vatPricingMode === "exclusive"}
                      onChange={() =>
                        setForm((f) => ({ ...f, vatPricingMode: "exclusive" }))
                      }
                    />
                    {t("products.vatExclusive")}
                  </label>
                </div>

                <Input
                  label={
                    form.vatPricingMode === "inclusive"
                      ? t("products.salePriceInclVat")
                      : t("products.salePriceExclVat")
                  }
                  prefix="$"
                  inputMode="decimal"
                  value={form.priceInput}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, priceInput: e.target.value }))
                  }
                  placeholder="0.00"
                />

                {pricePreview && (
                  <div className="rounded bg-slate-50 p-2 text-xs text-slate-600">
                    {t("products.pricePreviewExcl")}{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.excl)}
                    </span>{" "}
                    · {t("products.pricePreviewVat")}{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.vat)}
                    </span>{" "}
                    · {t("products.pricePreviewIncl")}{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.incl)}
                    </span>
                  </div>
                )}

                {form.mode === "edit" && selectedProduct && (
                  <div className="text-xs text-slate-500">
                    {t("products.avgCostLabel")}{" "}
                    <span className="font-medium text-slate-700">
                      {formatUsd(selectedProduct.avgCostExclVatCents)}
                    </span>
                    <span className="ml-1 text-slate-400">{t("products.avgCostNote")}</span>
                  </div>
                )}
              </div>
            </div>

            {!form.isService && (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-sm font-medium text-slate-900">
                  {t("products.inventorySection")}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-slate-700">
                      {t("products.qtyOnHand")}
                    </div>
                    <div className="text-sm text-slate-700">
                      {form.mode === "edit"
                        ? (selectedProduct?.quantityOnHand ?? 0)
                        : 0}
                      {form.mode === "new" && (
                        <span className="ml-1 text-xs text-slate-400">
                          {t("products.adjustViaInventory")}
                        </span>
                      )}
                    </div>
                  </div>

                  <Input
                    label={t("products.reorderPoint")}
                    inputMode="numeric"
                    value={form.reorderPointInput}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        reorderPointInput: e.target.value,
                      }))
                    }
                    placeholder={t("products.optionalPlaceholder")}
                  />
                </div>
              </div>
            )}

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                {t("products.uomSection")}
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-700">
                  {t("products.stockUnit")}
                  <select
                    value={form.baseUomCode}
                    disabled={form.mode === "edit"}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        baseUomCode: e.target.value,
                        saleUomCode: f.saleUomCode || e.target.value,
                      }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-slate-100"
                  >
                    {uoms.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.name} ({u.code})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs font-medium text-slate-700">
                  {t("products.sellingUnit")}
                  <select
                    value={form.saleUomCode}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        saleUomCode: e.target.value,
                      }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                  >
                    {uoms.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.name} ({u.code})
                      </option>
                    ))}
                  </select>
                </label>

                {(() => {
                  const baseUomName =
                    uoms.find((u) => u.code === form.baseUomCode)?.name ??
                    form.baseUomCode;
                  const saleUomName =
                    uoms.find((u) => u.code === form.saleUomCode)?.name ??
                    form.saleUomCode;
                  const isSameUom = form.saleUomCode === form.baseUomCode;
                  const isSimple = form.saleFactorDen === "1";
                  const qtyInt = parseInt(form.saleFactorNum);

                  if (isSameUom) {
                    return (
                      <p className="text-xs text-slate-500">
                        {t("products.sameUom")}
                      </p>
                    );
                  }

                  return (
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">
                        {t("products.uomFactorLabel", { base: baseUomName, sale: saleUomName })}
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={form.saleFactorNum}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              saleFactorNum: e.target.value,
                              saleFactorDen: "1",
                            }))
                          }
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                        />
                      </label>
                      {isSimple && qtyInt >= 1 ? (
                        <p className="text-xs text-slate-500">
                          {t("products.uomFactorPreview", {
                            sale: saleUomName,
                            num: form.saleFactorNum,
                            base: baseUomName,
                          })}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-600">
                          {t("products.uomAdvanced")}
                        </p>
                      )}
                    </div>
                  );
                })()}

                <Input
                  label={t("products.saleUomPriceLabel")}
                  prefix="$"
                  inputMode="decimal"
                  value={form.salePriceInput}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      salePriceInput: e.target.value,
                    }))
                  }
                  placeholder={t("products.optionalPlaceholder")}
                  hint={t("products.saleUomPriceHint")}
                />
              </div>
            </div>

            {saveError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {saveError}
              </div>
            )}

            {saveOk && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {saveOk}
              </div>
            )}

            <Button
              variant="primary"
              className="w-full"
              disabled={saving}
              onClick={handleSave}
            >
              {saving
                ? t("products.saving")
                : form.mode === "new"
                  ? t("products.createProduct")
                  : t("products.saveChanges")}
            </Button>
          </CardBody>
        </Card>
        ) : (
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setShowImport(true)}
            >
              {t("products.importProducts")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                resetForm();
                setShowForm(true);
              }}
            >
              {t("products.newProduct")}
            </Button>
          </div>
        )}
      </div>

      {showImport && storeId && (
        <ProductImportDialog
          storeId={storeId}
          vatRates={vatRates}
          uoms={uoms}
          onClose={() => setShowImport(false)}
          onImported={() => void reload()}
        />
      )}
    </div>
  );
}
