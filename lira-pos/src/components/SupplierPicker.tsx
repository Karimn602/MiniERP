import { useEffect, useRef, useState } from "react";
import { suppliersRepo } from "../db/repos/suppliers";
import type { Supplier } from "../db/types";
import { Button } from "./ui/Button";
import clsx from "clsx";

export function SupplierPicker({
  storeId,
  value,
  onChange,
  disabled = false,
}: {
  storeId: string;
  value: Supplier | null;
  onChange: (s: Supplier | null) => void;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Supplier[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      const rows = await suppliersRepo.list({
        storeId,
        search: input.trim() || undefined,
        limit: 20,
      });
      if (!cancelled) setResults(rows);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [input, open, storeId]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    try {
      const created = await suppliersRepo.create({ storeId, name });
      onChange(created);
      setCreating(false);
      setOpen(false);
      setNewName("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      {value ? (
        <div className="flex items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm">
          <div>
            <div className="font-medium text-slate-900">{value.name}</div>
            {value.contactName && (
              <div className="text-xs text-slate-500">{value.contactName}</div>
            )}
          </div>
          {!disabled && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              Change
            </Button>
          )}
        </div>
      ) : (
        <input
          type="text"
          value={input}
          placeholder="Search supplier or type new name…"
          disabled={disabled}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-slate-50"
        />
      )}

      {!value && open && !creating && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-500">
              No suppliers match.
            </li>
          ) : (
            results.map((s) => (
              <li
                key={s.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(s);
                  setOpen(false);
                }}
                className={clsx(
                  "cursor-pointer px-3 py-2 text-sm hover:bg-slate-50",
                )}
              >
                <div className="font-medium">{s.name}</div>
                {s.contactName && (
                  <div className="text-xs text-slate-500">{s.contactName}</div>
                )}
              </li>
            ))
          )}
          <li
            className="cursor-pointer border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600 hover:bg-slate-100"
            onMouseDown={(e) => {
              e.preventDefault();
              setNewName(input);
              setCreating(true);
            }}
          >
            + New supplier
            {input.trim() && (
              <span className="font-medium text-slate-900"> "{input.trim()}"</span>
            )}
          </li>
        </ul>
      )}

      {!value && open && creating && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
          <label className="block text-xs font-medium text-slate-700">
            New supplier name
          </label>
          <input
            type="text"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" size="sm" onClick={handleCreate}>
              Create
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
