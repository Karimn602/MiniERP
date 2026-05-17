import { useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo } from "../db/repos/products";
import { barcodesRepo } from "../db/repos/barcodes";
import { vatRatesRepo } from "../db/repos/vatRates";
import { uomsRepo } from "../db/repos/uoms";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { suppliersRepo } from "../db/repos/suppliers";
import { purchasesRepo } from "../db/repos/purchases";
import { movementsRepo } from "../db/repos/movements";
import { formatUsd } from "../lib/money";
import { formatBps } from "../lib/vat";
import { todayLocalDate } from "../lib/dates";

export default function DevProbe() {
  const { storeId, userId } = useActiveContext();
  const [output, setOutput] = useState<string>("Press a button.");
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setOutput(`Running: ${label}…`);

    try {
      const result = await fn();
      setOutput(`✅ ${label}\n\n` + JSON.stringify(result, null, 2));
    } catch (e) {
      setOutput(
        `❌ ${label}\n\n` +
          (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">Dev probe</h2>

        <p className="text-sm text-slate-600">
          Exercises every repo. Remove before production.
        </p>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4 text-sm">
        <div className="font-medium text-slate-700">Active context</div>

        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
          <span>storeId:</span>
          <code className="text-slate-900">{storeId ?? "(none)"}</code>

          <span>userId:</span>
          <code className="text-slate-900">{userId ?? "(none)"}</code>
        </div>
      </div>

      <Section title="Phase 2A — products / barcodes / VAT / UoM">
        <Btn
          disabled={busy}
          onClick={() =>
            run("vatRatesRepo.listActive()", async () => {
              const rates = await vatRatesRepo.listActive();

              return rates.map((r) => ({
                name: r.name,
                rate: formatBps(r.rateBps),
                exempt: r.isExempt,
              }));
            })
          }
        >
          List VAT rates
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("uomsRepo.listActive()", async () =>
              (await uomsRepo.listActive()).map((u) => `${u.symbol} (${u.category})`),
            )
          }
        >
          List UoMs
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("productsRepo.listEnriched", async () => {
              const products = await productsRepo.listEnriched({
                storeId: storeId!,
              });

              return products.map((p) => ({
                name: p.name,
                stock: `${p.quantityOnHand} ${p.baseUom.uomCode}`,
                avgCost: formatUsd(p.avgCostInclVatCents),
                sale: formatUsd(p.priceInclVatCents),
              }));
            })
          }
        >
          List enriched products
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("scan 5281234567890", async () => {
              const r = await productsRepo.findByScan(storeId!, "5281234567890");

              return r
                ? {
                    product: r.product.name,
                    uom: r.resolvedUom.uomCode,
                    primary: r.matchedBarcode.isPrimary,
                  }
                : "(no match)";
            })
          }
        >
          Scan barcode
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("barcodes (olive oil)", async () => {
              const r = await barcodesRepo.listForProduct(
                "00000000-0000-0000-0000-0000000000d3",
              );

              return r.map((b) => ({
                barcode: b.barcode,
                primary: b.isPrimary,
              }));
            })
          }
        >
          List barcodes
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("today's FX rate", async () => {
              try {
                return await exchangeRatesRepo.getCurrentForToday(storeId!);
              } catch (e) {
                if (e instanceof Error && e.message === "NO_EXCHANGE_RATE_SET") {
                  return "(none set)";
                }

                throw e;
              }
            })
          }
        >
          Get FX rate
        </Btn>
      </Section>

      <Section title="Phase 2C — suppliers / purchases / inventory">
        <Btn
          disabled={busy}
          onClick={() =>
            run("suppliersRepo.list()", async () =>
              (await suppliersRepo.list({ storeId: storeId! })).map((s) => ({
                name: s.name,
                contact: s.contactName,
                active: s.isActive,
              })),
            )
          }
        >
          List suppliers
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("purchasesRepo.list()", async () =>
              (await purchasesRepo.list({ storeId: storeId! })).map((p) => ({
                no: p.purchaseNumber,
                date: p.purchaseDate,
                type: p.purchaseType,
                total: formatUsd(p.totalInclVatCents),
                status: p.status,
              })),
            )
          }
        >
          List purchases
        </Btn>

        <Btn
          disabled={busy}
          onClick={() =>
            run("movementsRepo.listRecent()", async () =>
              (
                await movementsRepo.listRecent({
                  storeId: storeId!,
                  limit: 20,
                })
              ).map((m) => ({
                when: m.postedAt,
                type: m.movementType,
                delta: m.quantityDelta,
                unitCost: formatUsd(m.unitCostInclVatCents),
              })),
            )
          }
        >
          List recent movements
        </Btn>

        <Btn
          disabled={busy}
          onClick={async () => {
            await run("E2E: supplier + purchase + stock check", async () => {
              const supplier = await suppliersRepo.create({
                storeId: storeId!,
                name: `Probe Supplier ${Date.now()}`,
              });

              const products = await productsRepo.listEnriched({
                storeId: storeId!,
                limit: 1,
              });

              if (products.length === 0) {
                throw new Error("No products to test with.");
              }

              const product = products[0];
              const beforeQoh = product.quantityOnHand;
              const beforeAvg = product.avgCostInclVatCents;
              const uom = product.baseUom;

              const result = await purchasesRepo.post({
                storeId: storeId!,
                supplierId: supplier.id,
                purchaseType: "normal",
                supplierReference: "PROBE-001",
                purchaseDate: todayLocalDate(),
                createdByUserId: userId,
                deviceId: null,
                notes: "Smoke test from dev probe",
                lines: [
                  {
                    purchaseItemId: "",
                    productId: product.id,
                    productNameSnapshot: product.name,
                    productSkuSnapshot: product.sku,
                    productUomIdSnapshot: uom.id,
                    uomCodeSnapshot: uom.uomCode,
                    factorNumSnapshot: uom.factor.num,
                    factorDenSnapshot: uom.factor.den,
                    quantityInUom: 10,
                    quantityBase: 10,
                    unitCostExclVatInUomCents: 100,
                    unitCostInclVatInUomCents: 111,
                    unitCostExclVatBaseCents: 100,
                    unitCostInclVatBaseCents: 111,
                    vatRateIdSnapshot: product.vatRateId,
                    vatRateBpsSnapshot: product.vatRate.rateBps,
                    lineSubtotalExclVatCents: 1000,
                    lineVatCents: 110,
                    lineTotalInclVatCents: 1110,
                  },
                ],
              });

              const after = await productsRepo.findByIdEnriched(product.id);

              return {
                purchaseNumber: result.purchaseNumber,
                postedAt: result.postedAt,
                movementsCreated: result.movementIds.length,
                stockBefore: `${beforeQoh} ${uom.uomCode}`,
                stockAfter: `${after!.quantityOnHand} ${uom.uomCode}`,
                avgCostBefore: formatUsd(beforeAvg),
                avgCostAfter: formatUsd(after!.avgCostInclVatCents),
              };
            });
          }}
        >
          🧪 E2E: post a tiny purchase
        </Btn>

        <Btn
          disabled={busy}
          onClick={async () => {
            await run("E2E: tiny adjustment", async () => {
              const products = await productsRepo.listEnriched({
                storeId: storeId!,
                limit: 1,
              });

              if (products.length === 0) {
                throw new Error("No products.");
              }

              const product = products[0];

              if (product.quantityOnHand < 1) {
                return "Skipped — product has no stock to adjust.";
              }

              const result = await movementsRepo.postAdjustment({
                storeId: storeId!,
                createdByUserId: userId,
                deviceId: null,
                reason: "Dev probe adjustment",
                lines: [
                  {
                    productId: product.id,
                    uomCodeSnapshot: product.baseUom.uomCode,
                    factorNumSnapshot: 1,
                    factorDenSnapshot: 1,
                    quantityInUomSigned: -1,
                    quantityBaseSigned: -1,
                  },
                ],
              });

              const after = await productsRepo.findByIdEnriched(product.id);

              return {
                productName: product.name,
                stockBefore: product.quantityOnHand,
                stockAfter: after!.quantityOnHand,
                movement: result.movementIds[0],
              };
            });
          }}
        >
          🧪 E2E: -1 adjustment
        </Btn>
      </Section>

      <pre className="max-h-[60vh] overflow-auto rounded-md border border-slate-200 bg-slate-900 p-4 text-xs text-slate-100">
        {output}
      </pre>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>

      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}