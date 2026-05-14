import { useEffect, useRef, useState } from "react";
import { productsRepo } from "../db/repos/products";
import type { ProductWithUoms } from "../db/types";
import clsx from "clsx";

/**
 * Inline product search/picker. Used by Purchases and Adjustments to select
 * a product for a line. Avoids a heavy modal — just a search box with a
 * dropdown of matches.
 *
 * Searches by name, SKU, and exact barcode (productsRepo.list handles all three).
 * On select, calls onPick with the enriched product and clears the input.
 */
export function ProductPicker({
  storeId,
  onPick,
  excludeIds = [],
  placeholder = "Search by name, SKU, or barcode…",
  autoFocus = false,
}: {
  storeId: string;
  onPick: (product: ProductWithUoms) => void;
  excludeIds?: string[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<ProductWithUoms[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = input.trim();
    if (term.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const rows = await productsRepo.listEnriched({
          storeId,
          search: term,
          limit: 12,
        });
        if (cancelled) return;
        const filtered = rows.filter((p) => !excludeIds.includes(p.id));
        setResults(filtered);
        setHighlight(0);
        setOpen(filtered.length > 0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [input, storeId, excludeIds]);

  // Close dropdown on click-outside.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function commit(p: ProductWithUoms) {
    onPick(p);
    setInput("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={input}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const p = results[highlight];
            if (p) commit(p);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
      />

      {open && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {loading && (
            <li className="px-3 py-2 text-xs text-slate-500">Searching…</li>
          )}
          {!loading && results.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-500">No matches.</li>
          )}
          {results.map((p, i) => (
            <li
              key={p.id}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                // Use mousedown so the click commits before the input blurs.
                e.preventDefault();
                commit(p);
              }}
              className={clsx(
                "cursor-pointer px-3 py-2 text-sm",
                i === highlight ? "bg-brand text-brand-fg" : "hover:bg-slate-50",
              )}
            >
              <div className="font-medium">{p.name}</div>
              <div
                className={clsx(
                  "text-xs",
                  i === highlight ? "text-brand-fg/80" : "text-slate-500",
                )}
              >
                {p.sku && <span>SKU: {p.sku}</span>}
                {p.sku && p.primaryBarcode && <span> · </span>}
                {p.primaryBarcode && <span>{p.primaryBarcode.barcode}</span>}
                <span> · stock {p.quantityOnHand} {p.baseUom.uomCode}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
