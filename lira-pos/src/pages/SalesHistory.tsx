// src/pages/SalesHistory.tsx

import { useCallback, useEffect, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { salesRepo } from "../db/repos/sales";
import type { Sale } from "../db/types";
import { Card, CardHeader } from "../components/ui/Card";
import { formatUsd } from "../lib/money";
import { formatPrettyDate, relativeFromToday } from "../lib/dates";
import clsx from "clsx";

function isoToLocalDate(iso: string): string {
  return iso.slice(0, 10);
}

function isoToTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SalesHistory() {
  const { storeId, hydrated } = useActiveContext();
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!storeId) return;

    setLoading(true);
    setLoadError(null);

    try {
      const rows = await salesRepo.list({ storeId, limit: 200 });
      setSales(rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) void reload();
  }, [hydrated, reload]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">Sales History</h2>

        <p className="text-sm text-slate-600">
          Posted sales are immutable. Receipt detail &amp; reprint arrive with
          the printer integration.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Sales"
          subtitle={
            loading
              ? "Loading…"
              : `${sales.length} record${sales.length === 1 ? "" : "s"}`
          }
        />

        {loadError && (
          <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
            Failed to load sales: {loadError}
          </div>
        )}

        {sales.length === 0 && !loading && !loadError ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No sales yet. Post your first sale from the POS Register.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Receipt #</th>
                  <th className="px-5 py-2">Date</th>
                  <th className="px-5 py-2">Time</th>
                  <th className="px-5 py-2 text-right">Subtotal</th>
                  <th className="px-5 py-2 text-right">VAT</th>
                  <th className="px-5 py-2 text-right">Total</th>
                  <th className="px-5 py-2">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {sales.map((s) => {
                  const dateIso = s.postedAt ?? s.createdAt;
                  const localDate = isoToLocalDate(dateIso);

                  return (
                    <tr key={s.id}>
                      <td className="px-5 py-2 font-medium text-slate-900">
                        #{s.receiptNumber}
                      </td>

                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(localDate)}

                        <div className="text-xs text-slate-500">
                          {relativeFromToday(localDate)}
                        </div>
                      </td>

                      <td className="px-5 py-2 text-slate-600">
                        {isoToTime(dateIso)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {formatUsd(s.subtotalExclVatCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {formatUsd(s.vatTotalCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
                        {formatUsd(s.totalInclVatCents)}
                      </td>

                      <td className="px-5 py-2">
                        <span
                          className={clsx(
                            "rounded px-2 py-0.5 text-xs font-medium",
                            s.status === "posted" &&
                              "bg-emerald-100 text-emerald-800",
                            s.status === "draft" &&
                              "bg-amber-100 text-amber-800",
                            s.status === "voided" &&
                              "bg-slate-200 text-slate-600 line-through",
                          )}
                        >
                          {s.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}