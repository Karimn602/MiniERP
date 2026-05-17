import { useEffect, useState, useMemo, useCallback } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo, DuplicateSkuError } from "../db/repos/products";
import { barcodesRepo } from "../db/repos/barcodes";
import { vatRatesRepo } from "../db/repos/vatRates";
import { uomsRepo } from "../db/repos/uoms";
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

  avgCostInput: string;
  quantityInput: string;
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

  avgCostInput: "",
  quantityInput: "0",
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

function getProductStockDisplay(p: ProductWithUoms): string {
  if (p.isService) return "Service";
  return `${p.quantityOnHand} ${p.baseUom.uomCode}`;
}

function getPrimaryBarcodeDisplay(p: ProductWithUoms): string {
  return p.primaryBarcode?.barcode ?? "—";
}

export default function Products() {
  const { storeId, hydrated } = useActiveContext();

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

  function editProduct(product: ProductWithUoms) {
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

      avgCostInput: (product.avgCostExclVatCents / 100).toFixed(2),
      quantityInput: String(product.quantityOnHand),
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
      if (!name) throw new Error("Product name is required.");

      const sku = form.sku.trim() || null;
      const description = form.description.trim() || null;

      const barcode = form.barcode.trim();

      if (form.mode === "new" && !form.isService && !barcode) {
        throw new Error("Barcode is required for stock products.");
      }

      if (barcode.length === 13 && /^\d+$/.test(barcode) && !isValidEan13(barcode)) {
        throw new Error("EAN-13 checksum is invalid. Double-check the barcode.");
      }

      if (!form.vatRateId) throw new Error("VAT rate is required.");
      if (!form.priceInput.trim()) throw new Error("Sale price is required.");

      const typedPriceCents = parseUsdInput(form.priceInput);

      const price =
        form.vatPricingMode === "inclusive"
          ? splitInclVat(typedPriceCents, currentVatBps)
          : splitExclVat(typedPriceCents, currentVatBps);

      const avgCostExclVatCents = form.avgCostInput.trim()
        ? parseUsdInput(form.avgCostInput)
        : 0;

      const quantityOnHand = form.isService
        ? 0
        : toIntInput(form.quantityInput, 0);

      if (quantityOnHand < 0) {
        throw new Error("Quantity on hand cannot be negative.");
      }

      const reorderPoint =
        form.reorderPointInput.trim() === ""
          ? null
          : toIntInput(form.reorderPointInput);

      if (reorderPoint !== null && reorderPoint < 0) {
        throw new Error("Reorder point cannot be negative.");
      }

      const factor = validateFactor(
        toIntInput(form.saleFactorNum, 1),
        toIntInput(form.saleFactorDen, 1),
      );

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

        setSaveOk("Product created.");
      } else {
        if (!form.id) throw new Error("Missing product id.");

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

        if (barcode && selectedProduct?.primaryBarcode?.barcode !== barcode) {
          await barcodesRepo.addBarcode({
            productId: form.id,
            barcode,
            barcodeType: inferBarcodeType(barcode),
            makePrimary: true,
          });
        }

        setSaveOk("Product updated.");
      }

      await reload();

      if (form.mode === "new") {
        resetForm();
      }
    } catch (e) {
      if (e instanceof DuplicateSkuError) {
        setSaveError("SKU already exists. Use a different SKU or leave it blank.");
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading products…</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Products</h2>
          <p className="text-sm text-slate-600">
            Create products, assign barcodes, set VAT pricing, and manage UoM.
          </p>
        </div>

        <Card>
          <CardHeader
            title="Product list"
            subtitle={
              loading
                ? "Loading…"
                : `${filteredProducts.length} product${
                    filteredProducts.length === 1 ? "" : "s"
                  }`
            }
          />

          {loadError && (
            <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
              Failed to load products: {loadError}
            </div>
          )}

          {filteredProducts.length === 0 && !loading && !loadError ? (
            <div className="px-5 py-8 text-center text-sm text-slate-500">
              No products yet. Create your first product on the right.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2">Product</th>
                    <th className="px-5 py-2">Barcode</th>
                    <th className="px-5 py-2">VAT</th>
                    <th className="px-5 py-2 text-right">Price</th>
                    <th className="px-5 py-2 text-right">Cost</th>
                    <th className="px-5 py-2 text-right">Stock</th>
                    <th className="px-5 py-2">Status</th>
                    <th className="px-5 py-2"></th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100">
                  {filteredProducts.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-5 py-2">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">
                          {p.sku ? `SKU ${p.sku}` : "No SKU"}
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
                        {getProductStockDisplay(p)}
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
                          {p.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>

                      <td className="px-5 py-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => editProduct(p)}>
                          Edit
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
        <Card>
          <CardHeader
            title={form.mode === "new" ? "New product" : "Edit product"}
            subtitle={
              form.mode === "new"
                ? "Add a stock product or service."
                : selectedProduct?.name
            }
            actions={
              form.mode === "edit" ? (
                <Button variant="ghost" size="sm" onClick={resetForm}>
                  New
                </Button>
              ) : undefined
            }
          />

          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-3">
              <Input
                label="Name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Coca-Cola 330ml"
              />

              <Input
                label="SKU"
                value={form.sku}
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                placeholder="Optional"
              />

              <Input
                label="Description"
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Optional"
              />

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isService}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      isService: e.target.checked,
                      quantityInput: e.target.checked ? "0" : f.quantityInput,
                    }))
                  }
                />
                <span>Service item — no inventory movement</span>
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
                  <span>Active</span>
                </label>
              )}
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                Barcode
              </div>

              {form.mode === "new" ? (
                <Input
                  label={form.isService ? "Barcode (optional)" : "Barcode"}
                  value={form.barcode}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, barcode: e.target.value }))
                  }
                  placeholder="Scan or type barcode"
                  hint={
                    form.barcode.length === 13 &&
                    /^\d+$/.test(form.barcode) &&
                    !isValidEan13(form.barcode)
                      ? "EAN-13 checksum looks invalid."
                      : undefined
                  }
                />
              ) : form.id ? (
                <div className="space-y-3">
                  <Input
                    label="Set / add primary barcode"
                    value={form.barcode}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, barcode: e.target.value }))
                    }
                    placeholder="Scan or type barcode"
                  />
                  <BarcodeManager productId={form.id} />
                </div>
              ) : null}
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                VAT and price
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-700">
                  VAT rate
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
                    VAT inclusive
                  </label>

                  <label className="flex items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
                    <input
                      type="radio"
                      checked={form.vatPricingMode === "exclusive"}
                      onChange={() =>
                        setForm((f) => ({ ...f, vatPricingMode: "exclusive" }))
                      }
                    />
                    VAT exclusive
                  </label>
                </div>

                <Input
                  label={
                    form.vatPricingMode === "inclusive"
                      ? "Sale price incl. VAT"
                      : "Sale price excl. VAT"
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
                    Excl VAT:{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.excl)}
                    </span>{" "}
                    · VAT:{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.vat)}
                    </span>{" "}
                    · Incl VAT:{" "}
                    <span className="font-medium">
                      {formatUsd(pricePreview.incl)}
                    </span>
                  </div>
                )}

                <Input
                  label="Average cost excl. VAT"
                  prefix="$"
                  inputMode="decimal"
                  value={form.avgCostInput}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, avgCostInput: e.target.value }))
                  }
                  placeholder="0.00"
                />
              </div>
            </div>

            {!form.isService && (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-sm font-medium text-slate-900">
                  Inventory
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Quantity on hand"
                    inputMode="numeric"
                    value={form.quantityInput}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        quantityInput: e.target.value,
                      }))
                    }
                    placeholder="0"
                  />

                  <Input
                    label="Reorder point"
                    inputMode="numeric"
                    value={form.reorderPointInput}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        reorderPointInput: e.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </div>
              </div>
            )}

            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-900">
                Units of measure
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-700">
                  Base UoM
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
                  Default sale UoM
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

                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Factor numerator"
                    inputMode="numeric"
                    value={form.saleFactorNum}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        saleFactorNum: e.target.value,
                      }))
                    }
                  />

                  <Input
                    label="Factor denominator"
                    inputMode="numeric"
                    value={form.saleFactorDen}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        saleFactorDen: e.target.value,
                      }))
                    }
                  />
                </div>

                <p className="text-xs text-slate-500">
                  Example: if one box contains 12 pieces, sale UoM = box,
                  factor numerator = 12, denominator = 1.
                </p>

                <Input
                  label="Sale UoM price incl. VAT override"
                  prefix="$"
                  inputMode="decimal"
                  value={form.salePriceInput}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      salePriceInput: e.target.value,
                    }))
                  }
                  placeholder="Optional"
                  hint="Leave empty to derive price from base price × factor."
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
                ? "Saving…"
                : form.mode === "new"
                  ? "Create product"
                  : "Save changes"}
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}