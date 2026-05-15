import { useEffect, useState, useMemo, useCallback, useId } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo, DuplicateSkuError } from "../db/repos/products";
import { vatRatesRepo } from "../db/repos/vatRates";
import { uomsRepo } from "../db/repos/uoms";
import type {
  ProductWithUoms,
  VatRate,
  UnitOfMeasure,
  VatPricingMode,
} from "../db/types";
import { formatUsd, parseUsdInput } from "../lib/money";
import { formatBps, addVat, stripVat } from "../lib/vat";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import clsx from "clsx";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** What the form is doing: creating a new product, or editing this one. */
type FormMode = { kind: "closed" } | { kind: "new" } | { kind: "edit"; product: ProductWithUoms };

export default function Products() {
  const { storeId } = useActiveContext();

  const [products, setProducts] = useState<ProductWithUoms[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 250);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
  const [toast, setToast] = useState<string | null>(null);

  const [vatRates, setVatRates] = useState<VatRate[]>([]);
  const [uoms, setUoms] = useState<UnitOfMeasure[]>([]);
  const [refDataReady, setRefDataReady] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [vr, u] = await Promise.all([
          vatRatesRepo.listActive(),
          uomsRepo.listActive(),
        ]);
        setVatRates(vr);
        setUoms(u);
        setRefDataReady(true);
      } catch (e) {
        console.error("Failed to load VAT rates / UoMs:", e);
      }
    })();
  }, []);

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const list = await productsRepo.listEnriched({
        storeId,
        search: debouncedSearch.trim() || undefined,
        includeInactive,
        limit: 200,
      });
      setProducts(list);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, debouncedSearch, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  function handleSaved(mode: "new" | "edit") {
    setFormMode({ kind: "closed" });
    flashToast(mode === "new" ? "✓ Product saved" : "✓ Changes saved");
    void reload();
  }

  async function handleToggleActive(p: ProductWithUoms) {
    try {
      await productsRepo.setActive(p.id, !p.isActive);
      flashToast(p.isActive ? "✓ Product blocked" : "✓ Product unblocked");
      void reload();
    } catch (e) {
      flashToast(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (loading && products.length === 0 && !loadError) {
    return <div className="text-sm text-slate-500">Loading products…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Products</h2>
          <p className="text-sm text-slate-600">
            Your catalog — items and services you sell.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {toast && <span className="text-sm text-emerald-700">{toast}</span>}
          <Button
            variant={formMode.kind !== "closed" ? "ghost" : "primary"}
            onClick={() =>
              setFormMode((m) =>
                m.kind === "closed" ? { kind: "new" } : { kind: "closed" },
              )
            }
            disabled={!refDataReady}
            title={!refDataReady ? "Loading VAT rates / UoMs…" : undefined}
          >
            {formMode.kind === "closed" ? "New product" : "Close form"}
          </Button>
        </div>
      </div>

      {formMode.kind !== "closed" && refDataReady && storeId && (
        <ProductForm
          mode={formMode}
          storeId={storeId}
          vatRates={vatRates}
          uoms={uoms}
          onSaved={handleSaved}
          onCancel={() => setFormMode({ kind: "closed" })}
        />
      )}

      <Card>
        <CardHeader
          title="Search"
          subtitle="By name, SKU, or barcode. Barcode matches exact; name and SKU match partial."
        />
        <CardBody className="space-y-3">
          <Input
            placeholder="Type to search…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-slate-300"
            />
            Include inactive products
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Catalog"
          subtitle={
            loading
              ? "Loading…"
              : `${products.length} ${products.length === 1 ? "product" : "products"}`
          }
        />
        {loadError ? (
          <CardBody>
            <p className="text-sm text-red-700">Failed to load: {loadError}</p>
          </CardBody>
        ) : products.length === 0 && !loading ? (
          <CardBody>
            <div className="py-8 text-center text-sm text-slate-500">
              {debouncedSearch.trim()
                ? `No products match "${debouncedSearch.trim()}".`
                : 'No products yet. Click "New product" to add one.'}
            </div>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-5 py-2 font-medium">SKU</th>
                  <th className="px-5 py-2 font-medium text-right">Price (incl. VAT)</th>
                  <th className="px-5 py-2 font-medium">VAT</th>
                  <th className="px-5 py-2 font-medium text-right">Stock</th>
                  <th className="px-5 py-2 font-medium">Barcode</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.map((p) => (
                  <tr
                    key={p.id}
                    className={clsx(
                      "cursor-pointer transition-colors hover:bg-slate-50",
                      !p.isActive && "bg-slate-50/60 text-slate-500",
                    )}
                    onClick={(e) => {
                      // Don't trigger edit if the click landed on an action button.
                      if ((e.target as HTMLElement).closest("button")) return;
                      setFormMode({ kind: "edit", product: p });
                    }}
                  >
                    <td className="px-5 py-2">
                      <div className="font-medium text-slate-900">
                        {p.name}
                        {!p.isActive && (
                          <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                            Inactive
                          </span>
                        )}
                        {p.isService && (
                          <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700">
                            Service
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <div className="mt-0.5 text-xs text-slate-500">{p.description}</div>
                      )}
                    </td>
                    <td className="px-5 py-2 text-slate-600">
                      {p.sku ? <code className="text-xs">{p.sku}</code> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <div className="font-medium text-slate-900">{formatUsd(p.priceInclVatCents)}</div>
                      <div className="text-[10px] text-slate-500">
                        {p.vatPricingMode === "inclusive" ? "entered tax-incl." : "derived from net"}
                      </div>
                    </td>
                    <td className="px-5 py-2 text-slate-700">
                      {p.vatRate.isExempt ? (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">Exempt</span>
                      ) : (
                        <span className="text-xs">{formatBps(p.vatRate.rateBps)}</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-right text-slate-700">
                      {p.isService ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <span className="text-xs">
                          {p.quantityOnHand} <span className="text-slate-500">{p.baseUom.uomCode}</span>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2">
                      {p.primaryBarcode ? (
                        <code className="text-xs text-slate-600">{p.primaryBarcode.barcode}</code>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleToggleActive(p)}
                      >
                        {p.isActive ? "Block" : "Unblock"}
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
  );
}

// ============================================================================
// Product form — handles both "new" and "edit" modes
// ============================================================================

function ProductForm({
  mode,
  storeId,
  vatRates,
  uoms,
  onSaved,
  onCancel,
}: {
  mode: Exclude<FormMode, { kind: "closed" }>;
  storeId: string;
  vatRates: VatRate[];
  uoms: UnitOfMeasure[];
  onSaved: (mode: "new" | "edit") => void;
  onCancel: () => void;
}) {
  const isEdit = mode.kind === "edit";
  const existing = isEdit ? mode.product : null;

  // Smart defaults for the "new" case.
  const defaultVatRateId = useMemo(() => {
    if (existing) return existing.vatRateId;
    const candidate =
      [...vatRates]
        .filter((r) => !r.isExempt && r.rateBps > 0)
        .sort((a, b) => a.rateBps - b.rateBps)[0] ?? vatRates[0];
    return candidate?.id ?? "";
  }, [vatRates, existing]);

  const defaultUomCode = useMemo(() => {
    if (existing) return existing.baseUom.uomCode;
    return (
      uoms.find((u) => u.code === "pcs")?.code ??
      uoms.find((u) => u.code === "each")?.code ??
      uoms[0]?.code ??
      ""
    );
  }, [uoms, existing]);

  // Initial price input depends on pricing mode.
  const defaultPriceInput = useMemo(() => {
    if (!existing) return "";
    const cents =
      existing.vatPricingMode === "inclusive"
        ? existing.priceInclVatCents
        : existing.priceExclVatCents;
    return (cents / 100).toFixed(2);
  }, [existing]);

  const [name, setName] = useState(existing?.name ?? "");
  const [sku, setSku] = useState(existing?.sku ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [vatRateId, setVatRateId] = useState(defaultVatRateId);
  const [vatPricingMode, setVatPricingMode] = useState<VatPricingMode>(
    existing?.vatPricingMode ?? "inclusive",
  );
  const [priceInput, setPriceInput] = useState(defaultPriceInput);
  const [reorderPointInput, setReorderPointInput] = useState(
    existing?.reorderPoint != null ? String(existing.reorderPoint) : "",
  );
  const [isService, setIsService] = useState(existing?.isService ?? false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ [k: string]: string }>({});

  const selectedVatRate = useMemo(
    () => vatRates.find((r) => r.id === vatRateId) ?? null,
    [vatRateId, vatRates],
  );

  const parsedPriceCents = useMemo(() => {
    if (priceInput.trim() === "") return null;
    try { return parseUsdInput(priceInput); } catch { return null; }
  }, [priceInput]);

  const derivedPrices = useMemo(() => {
    if (parsedPriceCents === null || !selectedVatRate) return null;
    const bps = selectedVatRate.rateBps;
    if (vatPricingMode === "inclusive") {
      const excl = stripVat(parsedPriceCents, bps);
      return { inclVatCents: parsedPriceCents, exclVatCents: excl, vatCents: parsedPriceCents - excl };
    } else {
      const incl = addVat(parsedPriceCents, bps);
      return { exclVatCents: parsedPriceCents, inclVatCents: incl, vatCents: incl - parsedPriceCents };
    }
  }, [parsedPriceCents, selectedVatRate, vatPricingMode]);

  function validate(): boolean {
    const errors: { [k: string]: string } = {};
    const trimmedName = name.trim();
    if (trimmedName === "") errors.name = "Name is required.";
    else if (trimmedName.length > 200) errors.name = "Max 200 characters.";

    if (sku.trim().length > 100) errors.sku = "Max 100 characters.";
    if (description.length > 1000) errors.description = "Max 1000 characters.";

    if (vatRateId === "") errors.vatRateId = "Select a VAT rate.";

    if (priceInput.trim() === "") errors.price = "Price is required.";
    else if (parsedPriceCents === null) errors.price = "Invalid amount. Use e.g. 9.99.";
    else if (parsedPriceCents < 0) errors.price = "Price must be non-negative.";

    if (!isService && reorderPointInput.trim() !== "") {
      const rp = Number(reorderPointInput);
      if (!Number.isInteger(rp) || rp < 0) errors.reorderPoint = "Whole non-negative number.";
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit() {
    setFormError(null);
    if (!validate() || !derivedPrices) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim() === "" ? null : sku.trim(),
        description: description.trim() === "" ? null : description.trim(),
        vatRateId,
        vatPricingMode,
        priceExclVatCents: derivedPrices.exclVatCents,
        priceInclVatCents: derivedPrices.inclVatCents,
        reorderPoint:
          isService || reorderPointInput.trim() === ""
            ? null
            : Number(reorderPointInput),
        isService,
      };

      if (existing) {
        await productsRepo.update(existing.id, payload);
        onSaved("edit");
      } else {
        await productsRepo.create({
          storeId,
          ...payload,
          baseUomCode: defaultUomCode,
        });
        onSaved("new");
      }
    } catch (e) {
      if (e instanceof DuplicateSkuError) {
        setFieldErrors((prev) => ({ ...prev, sku: e.message }));
      } else {
        setFormError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={isEdit ? `Edit "${existing!.name}"` : "New product"}
        subtitle={
          isEdit
            ? "Changes apply going forward. Historical sales and inventory movements keep their original snapshots."
            : "Add a new item or service to your catalog."
        }
        actions={
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <Input
          label="Name *"
          placeholder="e.g. Coffee 250g"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          autoFocus
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="SKU (optional)"
            placeholder="e.g. DEMO-001"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            error={fieldErrors.sku}
            hint="Unique per store. Leave blank if not used."
          />
          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isService}
                onChange={(e) => setIsService(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              This is a service (no stock tracked)
            </label>
          </div>
        </div>

        <Input
          label="Description (optional)"
          placeholder="Short description for receipts"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={fieldErrors.description}
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField
            label="VAT rate *"
            value={vatRateId}
            onChange={setVatRateId}
            error={fieldErrors.vatRateId}
          >
            {vatRates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.isExempt ? " (exempt)" : ` — ${formatBps(r.rateBps)}`}
              </option>
            ))}
          </SelectField>

          {isEdit ? (
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Base unit of measure
              </label>
              <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {existing!.baseUom.uomCode}
                <span className="ml-2 text-xs text-slate-500">(locked after creation)</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Stock and cost values are denominated in this UoM. Changing it
                would invalidate history.
              </p>
            </div>
          ) : (
            <SelectField
              label="Base unit of measure *"
              value={defaultUomCode}
              onChange={() => { /* fixed for now; multi-UoM mgmt is its own phase */ }}
              hint="The canonical unit stock is tracked in."
            >
              {uoms.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name} ({u.symbol})
                </option>
              ))}
            </SelectField>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-700">
              Pricing mode *
            </label>
            <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setVatPricingMode("inclusive")}
                className={clsx(
                  "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                  vatPricingMode === "inclusive"
                    ? "bg-brand text-brand-fg"
                    : "text-slate-600 hover:bg-slate-50",
                )}
              >
                Incl. VAT
              </button>
              <button
                type="button"
                onClick={() => setVatPricingMode("exclusive")}
                className={clsx(
                  "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                  vatPricingMode === "exclusive"
                    ? "bg-brand text-brand-fg"
                    : "text-slate-600 hover:bg-slate-50",
                )}
              >
                Excl. VAT
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {vatPricingMode === "inclusive"
                ? "Price you enter includes VAT."
                : "Price you enter excludes VAT; tax adds at checkout."}
            </p>
          </div>

          <Input
            label="Price (USD) *"
            placeholder="e.g. 9.99"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            error={fieldErrors.price}
            prefix="$"
            inputMode="decimal"
          />
        </div>

        {derivedPrices && selectedVatRate && (
          <PricePreview
            derived={derivedPrices}
            vatRate={selectedVatRate}
            mode={vatPricingMode}
          />
        )}

        {!isService && (
          <Input
            label="Reorder point (optional)"
            placeholder="e.g. 10"
            value={reorderPointInput}
            onChange={(e) => setReorderPointInput(e.target.value)}
            error={fieldErrors.reorderPoint}
            hint="Warning threshold in base UoM. Leave blank to disable."
            inputMode="numeric"
          />
        )}

        {formError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {formError}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || derivedPrices === null}
          >
            {submitting
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Save product"}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          {!isEdit && (
            <p className="ml-auto text-xs text-slate-500">
              Starting stock: 0 — add stock via Inventory after creating.
            </p>
          )}
          {isEdit && (
            <p className="ml-auto text-xs text-slate-500">
              Editing #{existing!.sku ?? existing!.id.slice(0, 6)} · stock {existing!.quantityOnHand} {existing!.baseUom.uomCode}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Small local helpers (Select + PricePreview)
// ============================================================================

function SelectField({
  label,
  value,
  onChange,
  error,
  hint,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errId : hint ? hintId : undefined}
        className={clsx(
          "block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:outline-none focus:ring-2",
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-100"
            : "border-slate-300 focus:border-brand focus:ring-brand/20",
        )}
      >
        {children}
      </select>
      {error ? (
        <p id={errId} className="text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

function PricePreview({
  derived,
  vatRate,
  mode,
}: {
  derived: { exclVatCents: number; inclVatCents: number; vatCents: number };
  vatRate: VatRate;
  mode: VatPricingMode;
}) {
  if (vatRate.isExempt || vatRate.rateBps === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-medium text-slate-600">
          {vatRate.isExempt ? "VAT-exempt" : "Zero-rated"} — net and gross are identical
        </div>
        <div className="mt-1 text-lg font-semibold text-slate-900">
          {formatUsd(derived.inclVatCents)}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-xs font-medium text-slate-600">
        Price breakdown at {formatBps(vatRate.rateBps)} VAT
        <span className="ml-2 text-slate-500">
          (you entered {mode === "inclusive" ? "gross" : "net"})
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-white px-3 py-2">
          <div className="text-slate-500">Net (excl. VAT)</div>
          <div className="mt-0.5 font-medium text-slate-900">{formatUsd(derived.exclVatCents)}</div>
        </div>
        <div className="rounded bg-white px-3 py-2">
          <div className="text-slate-500">VAT</div>
          <div className="mt-0.5 font-medium text-slate-900">{formatUsd(derived.vatCents)}</div>
        </div>
        <div className="rounded bg-white px-3 py-2 ring-1 ring-emerald-200">
          <div className="text-slate-500">Gross (incl. VAT)</div>
          <div className="mt-0.5 font-medium text-emerald-900">{formatUsd(derived.inclVatCents)}</div>
        </div>
      </div>
    </div>
  );
}