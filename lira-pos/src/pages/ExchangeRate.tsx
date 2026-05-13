import { useEffect, useState, useMemo, useCallback } from "react";
import { useActiveContext } from "../state/activeContext";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import type { ExchangeRate } from "../db/types";
import {
  todayLocalDate,
  daysBetween,
  formatPrettyDate,
  relativeFromToday,
} from "../lib/dates";
import { parseRateInput, formatRate, formatUsd, usdCentsToLbp, formatLbp } from "../lib/money";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import clsx from "clsx";

export default function ExchangeRate() {
  const { storeId, userId } = useActiveContext();

  const [current, setCurrent] = useState<ExchangeRate | null>(null);
  const [history, setHistory] = useState<ExchangeRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rateInput, setRateInput] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const today = useMemo(() => todayLocalDate(), []);

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const list = await exchangeRatesRepo.list(storeId, 200);
      setHistory(list);
      const cur = list.find((r) => r.effectiveDate <= today) ?? null;
      setCurrent(cur);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const status: "none" | "current" | "stale" = useMemo(() => {
    if (!current) return "none";
    if (current.effectiveDate === today) return "current";
    return "stale";
  }, [current, today]);

  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => {
    if (!loading) setFormOpen(status !== "current");
  }, [loading, status]);

  const parsedRate = useMemo(() => {
    if (rateInput.trim() === "") return null;
    try {
      return parseRateInput(rateInput);
    } catch {
      return null;
    }
  }, [rateInput]);

  /** Soft warning if the new rate differs by >30% from the most recent rate. */
  const sanityWarning = useMemo(() => {
    if (!parsedRate || !current) return null;
    const diff = Math.abs(parsedRate - current.rateLbpPerUsd);
    const ratio = diff / current.rateLbpPerUsd;
    if (ratio < 0.3) return null;
    const direction = parsedRate > current.rateLbpPerUsd ? "higher" : "lower";
    const pct = Math.round(ratio * 100);
    return `This rate is ${pct}% ${direction} than your last (${formatRate(current.rateLbpPerUsd)}). Double-check before saving.`;
  }, [parsedRate, current]);

  const preview = useMemo(() => {
    if (!parsedRate) return null;
    return [100, 1000, 10000].map((cents) => ({
      usdCents: cents,
      lbp: usdCentsToLbp(cents, parsedRate),
    }));
  }, [parsedRate]);

  async function handleSubmit() {
    setFormError(null);
    if (!parsedRate) {
      setFormError("Enter a valid positive integer (e.g. 89500).");
      return;
    }
    if (!storeId) return;

    setSubmitting(true);
    try {
      await exchangeRatesRepo.upsert({
        storeId,
        effectiveDate: today,
        rateLbpPerUsd: parsedRate,
        source: "manual",
        notes: notes.trim() || null,
        createdByUserId: userId,
      });
      setRateInput("");
      setNotes("");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-500">Loading exchange rates…</div>;
  }

  if (loadError) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-red-700">Failed to load: {loadError}</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">Exchange Rate</h2>
        <p className="text-sm text-slate-600">
          Set the daily LBP / USD rate used by the POS for every sale today.
        </p>
      </div>

      <StatusBanner status={status} current={current} />

      <Card>
        <CardHeader
          title={
            status === "current"
              ? "Update today's rate"
              : status === "stale"
                ? "Set today's rate"
                : "Set the first rate"
          }
          subtitle={
            status === "current"
              ? `You already have a rate for ${formatPrettyDate(today)}. Saving will overwrite it.`
              : `New rate effective for ${formatPrettyDate(today)}.`
          }
          actions={
            status === "current" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFormOpen((v) => !v)}
              >
                {formOpen ? "Cancel" : "Update"}
              </Button>
            ) : null
          }
        />
        {formOpen && (
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label="Rate (LBP per 1 USD)"
                placeholder="e.g. 89500"
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                error={formError}
                hint="Enter a whole number. No decimals."
                suffix="L.L. / USD"
                inputMode="numeric"
                autoFocus
              />
              <Input
                label="Notes (optional)"
                placeholder="e.g. Sayrafa morning fixing"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                hint="Visible later in the history table."
              />
            </div>

            {sanityWarning && (
              <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
                ⚠ {sanityWarning}
              </div>
            )}

            {preview && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">
                  Preview at {formatRate(parsedRate!)}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {preview.map((p) => (
                    <div key={p.usdCents} className="rounded bg-white px-3 py-2">
                      <div className="font-medium text-slate-900">
                        {formatUsd(p.usdCents)}
                      </div>
                      <div className="text-slate-500">{formatLbp(p.lbp)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={submitting || parsedRate === null}
              >
                {submitting
                  ? "Saving…"
                  : status === "current"
                    ? "Update rate"
                    : "Save rate"}
              </Button>
              {justSaved && (
                <span className="text-sm text-emerald-700">✓ Saved</span>
              )}
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Rate history"
          subtitle={`${history.length} record${history.length === 1 ? "" : "s"}`}
        />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Effective date</th>
                <th className="px-5 py-2 font-medium">Rate</th>
                <th className="px-5 py-2 font-medium">Source</th>
                <th className="px-5 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-6 text-center text-sm text-slate-500">
                    No rates yet. Set one above.
                  </td>
                </tr>
              ) : (
                history.map((r) => (
                  <tr
                    key={r.id}
                    className={clsx(r.effectiveDate === today && "bg-emerald-50/40")}
                  >
                    <td className="px-5 py-2 text-slate-900">
                      <div>{formatPrettyDate(r.effectiveDate)}</div>
                      <div className="text-xs text-slate-500">
                        {relativeFromToday(r.effectiveDate)}
                      </div>
                    </td>
                    <td className="px-5 py-2 font-medium text-slate-900">
                      {formatRate(r.rateLbpPerUsd)}
                    </td>
                    <td className="px-5 py-2 text-slate-600">{r.source}</td>
                    <td className="px-5 py-2 text-slate-600">{r.notes ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatusBanner({
  status,
  current,
}: {
  status: "none" | "current" | "stale";
  current: ExchangeRate | null;
}) {
  if (status === "none") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">
          No exchange rate is set yet.
        </p>
        <p className="mt-1 text-xs text-amber-800">
          You can't post sales until a rate exists. Set today's rate below to get started.
        </p>
      </div>
    );
  }

  if (status === "current" && current) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-900">
              Up to date — rate set for today
            </p>
            <p className="mt-1 text-xs text-emerald-800">
              All sales today use this rate as the locked exchange rate.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold text-emerald-900">
              {formatRate(current.rateLbpPerUsd)}
            </div>
            <div className="text-xs text-emerald-800">
              {formatPrettyDate(current.effectiveDate)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "stale" && current) {
    const days = daysBetween(current.effectiveDate, todayLocalDate());
    return (
      <div className="rounded-md border border-orange-200 bg-orange-50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-orange-900">
              Rate is stale — last set {relativeFromToday(current.effectiveDate)}
            </p>
            <p className="mt-1 text-xs text-orange-800">
              The POS is still using this rate. Update it below if it's changed.
              {days >= 3 && " You haven't entered a new rate in a few days."}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold text-orange-900">
              {formatRate(current.rateLbpPerUsd)}
            </div>
            <div className="text-xs text-orange-800">
              {formatPrettyDate(current.effectiveDate)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}