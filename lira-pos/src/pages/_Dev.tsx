import { useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo } from "../db/repos/products";
import { barcodesRepo } from "../db/repos/barcodes";
import { vatRatesRepo } from "../db/repos/vatRates";
import { uomsRepo } from "../db/repos/uoms";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { formatUsd } from "../lib/money";
import { formatBps } from "../lib/vat";
import { formatQty } from "../lib/uom";

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
          Exercises every Phase 2A repo. Remove before production.
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

      <div className="flex flex-wrap gap-2">
        <Btn disabled={busy} onClick={() => run("vatRatesRepo.listActive()", async () => {
          const rates = await vatRatesRepo.listActive();
          return rates.map((r) => ({
            name: r.name,
            rate: formatBps(r.rateBps),
            exempt: r.isExempt,
            effective: r.effectiveFrom,
          }));
        })}>List VAT rates</Btn>

        <Btn disabled={busy} onClick={() => run("uomsRepo.listActive()", async () => {
          const uoms = await uomsRepo.listActive();
          return uoms.map((u) => `${u.symbol} (${u.category})`);
        })}>List UoMs</Btn>

        <Btn disabled={busy} onClick={() => run("productsRepo.list", async () => {
          const products = await productsRepo.list({ storeId: storeId! });
          return products.map((p) => ({
            name: p.name,
            priceInclVat: formatUsd(p.priceInclVatCents),
            mode: p.vatPricingMode,
            stock: p.quantityOnHand,
          }));
        })}>List products</Btn>

        <Btn disabled={busy} onClick={() => run("productsRepo.listEnriched", async () => {
          const products = await productsRepo.listEnriched({ storeId: storeId! });
          return products.map((p) => ({
            name: p.name,
            vatRate: formatBps(p.vatRate.rateBps),
            priceInclVat: formatUsd(p.priceInclVatCents),
            baseUom: p.baseUom.uomCode,
            defaultSaleUom: p.defaultSaleUom.uomCode,
            uomCount: p.uoms.length,
            stockInBase: formatQty(p.quantityOnHand, p.baseUom.factor, p.baseUom.uomCode),
            primaryBarcode: p.primaryBarcode?.barcode ?? "(none)",
          }));
        })}>List enriched</Btn>

        <Btn disabled={busy} onClick={() => run("scan 5281234567890", async () => {
          const r = await productsRepo.findByScan(storeId!, "5281234567890");
          if (!r) return "(no match)";
          return {
            productName: r.product.name,
            resolvedUom: r.resolvedUom.uomCode,
            factorNum: r.resolvedUom.factor.num,
            factorDen: r.resolvedUom.factor.den,
            matchedBarcodeType: r.matchedBarcode.barcodeType,
          };
        })}>Scan: 5281234567890</Btn>

        <Btn disabled={busy} onClick={() => run("scan ' sup-olive-5l ' (normalize)", async () => {
          const r = await productsRepo.findByScan(storeId!, "  sup-olive-5l  ");
          if (!r) return "(no match — normalization failed?)";
          return {
            productName: r.product.name,
            resolvedUom: r.resolvedUom.uomCode,
            matchedBarcodeType: r.matchedBarcode.barcodeType,
          };
        })}>Scan: " sup-olive-5l "</Btn>

        <Btn disabled={busy} onClick={() => run("search 'oil'", async () => {
          const r = await productsRepo.list({ storeId: storeId!, search: "oil" });
          return r.map((p) => p.name);
        })}>Search "oil"</Btn>

        <Btn disabled={busy} onClick={() => run("barcodes for olive oil", async () => {
          const r = await barcodesRepo.listForProduct("00000000-0000-0000-0000-0000000000d3");
          return r.map((b) => ({
            barcode: b.barcode,
            type: b.barcodeType,
            primary: b.isPrimary,
            active: b.isActive,
          }));
        })}>List barcodes (Olive Oil)</Btn>

        <Btn disabled={busy} onClick={() => run("today's FX rate", async () => {
          try {
            return await exchangeRatesRepo.getCurrentForToday(storeId!);
          } catch (e) {
            if (e instanceof Error && e.message === "NO_EXCHANGE_RATE_SET") {
              return "(no rate set — go to Exchange Rate screen)";
            }
            throw e;
          }
        })}>Get today's FX rate</Btn>
      </div>

      <pre className="max-h-[60vh] overflow-auto rounded-md border border-slate-200 bg-slate-900 p-4 text-xs text-slate-100">
        {output}
      </pre>
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