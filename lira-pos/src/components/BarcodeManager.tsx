import { useCallback, useEffect, useState } from "react";
import { barcodesRepo } from "../db/repos/barcodes";
import type { ProductBarcode } from "../db/types";
import { isValidEan13 } from "../lib/barcode";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import clsx from "clsx";

/**
 * Inline barcode manager for the Edit Product page.
 * - Lists all barcodes for a product, with the primary one starred.
 * - Add a new barcode (validates EAN-13 if scanner-style format detected).
 * - Click ★ to make a barcode primary (demotes the previous primary).
 * - ✕ to remove. Cannot remove the last barcode.
 *
 * Self-contained — owns its own loading state and reloads after each mutation.
 */
export function BarcodeManager({ productId }: { productId: string }) {
  const [rows, setRows] = useState<ProductBarcode[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await barcodesRepo.listForProduct(productId);
      setRows(list);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleAdd() {
    const code = adding.trim();
    setAddError(null);
    if (!code) {
      setAddError("Enter a barcode.");
      return;
    }
    if (code.length === 13 && /^\d+$/.test(code) && !isValidEan13(code)) {
      setAddError("EAN-13 checksum is invalid. Double-check the code.");
      return;
    }
    setAddBusy(true);
    try {
      await barcodesRepo.addBarcode({
        productId,
        barcode: code,
        // First barcode is automatically primary; the repo handles this.
      });
      setAdding("");
      await reload();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function handleSetPrimary(barcodeId: string) {
    await barcodesRepo.setPrimary(productId, barcodeId);
    await reload();
  }

  async function handleRemove(barcodeId: string) {
    if (rows.length <= 1) return; // safety; UI also blocks
    await barcodesRepo.remove(barcodeId);
    await reload();
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-700">Barcodes</label>

      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          No barcodes yet. Add at least one so this product can be scanned.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {rows.map((b) => (
            <li key={b.id} className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => !b.isPrimary && handleSetPrimary(b.id)}
                title={b.isPrimary ? "Primary barcode" : "Make primary"}
                className={clsx(
                  "text-base leading-none",
                  b.isPrimary ? "text-amber-500" : "text-slate-300 hover:text-amber-400",
                )}
              >
                ★
              </button>
              <code className="flex-1 font-mono text-sm text-slate-800">
                {b.barcode}
              </code>
              {b.isPrimary && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">
                  primary
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={rows.length <= 1}
                title={rows.length <= 1 ? "At least one barcode is required" : "Remove"}
                onClick={() => handleRemove(b.id)}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            placeholder="Scan or type a new barcode…"
            value={adding}
            onChange={(e) => {
              setAdding(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
          />
        </div>
        <Button variant="primary" size="sm" onClick={handleAdd} disabled={addBusy}>
          {addBusy ? "Adding…" : "Add"}
        </Button>
      </div>
      {addError && <p className="text-xs text-red-600">{addError}</p>}
    </div>
  );
}