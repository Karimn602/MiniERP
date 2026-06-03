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
import { PageHeader } from "../components/ui/PageHeader";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

export default function ExchangeRate() {
  const { storeId, userId } = useActiveContext();
  const { t } = useTranslation();

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

  const sanityWarning = useMemo(() => {
    if (!parsedRate || !current) return null;
    const diff = Math.abs(parsedRate - current.rateLbpPerUsd);
    const ratio = diff / current.rateLbpPerUsd;
    if (ratio < 0.3) return null;
    const direction = parsedRate > current.rateLbpPerUsd
      ? t("exchangeRate.sanityHigher")
      : t("exchangeRate.sanityLower");
    const pct = String(Math.round(ratio * 100));
    return t("exchangeRate.sanityWarning", {
      pct,
      direction,
      last: formatRate(current.rateLbpPerUsd),
    });
  }, [parsedRate, current, t]);

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

  const historySubtitle = t(
    history.length === 1 ? "exchangeRate.historyCountOne" : "exchangeRate.historyCountMany",
    { count: String(history.length) },
  );

  if (loading) {
    return <div className="text-sm text-slate-500">{t("exchangeRate.loading")}</div>;
  }

  if (loadError) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-red-700">{t("exchangeRate.loadFailed", { error: loadError })}</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("exchangeRate.title")} subtitle={t("exchangeRate.subtitle")} />

      <StatusBanner status={status} current={current} />

      <Card>
        <CardHeader
          title={
            status === "current"
              ? t("exchangeRate.formTitleUpdate")
              : status === "stale"
                ? t("exchangeRate.formTitleSet")
                : t("exchangeRate.formTitleFirst")
          }
          subtitle={
            status === "current"
              ? t("exchangeRate.formSubtitleOverwrite", { date: formatPrettyDate(today) })
              : t("exchangeRate.formSubtitleNew", { date: formatPrettyDate(today) })
          }
          actions={
            status === "current" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFormOpen((v) => !v)}
              >
                {formOpen ? t("exchangeRate.cancel") : t("exchangeRate.update")}
              </Button>
            ) : null
          }
        />
        {formOpen && (
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label={t("exchangeRate.rateLabel")}
                placeholder={t("exchangeRate.ratePlaceholder")}
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                error={formError}
                hint={t("exchangeRate.rateHint")}
                suffix={t("exchangeRate.rateSuffix")}
                inputMode="numeric"
                autoFocus
              />
              <Input
                label={t("exchangeRate.notesLabel")}
                placeholder={t("exchangeRate.notesPlaceholder")}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                hint={t("exchangeRate.notesHint")}
              />
            </div>

            {sanityWarning && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
                ⚠ {sanityWarning}
              </div>
            )}

            {preview && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">
                  {t("exchangeRate.previewAt", { rate: formatRate(parsedRate!) })}
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
                  ? t("exchangeRate.saving")
                  : status === "current"
                    ? t("exchangeRate.updateRate")
                    : t("exchangeRate.saveRate")}
              </Button>
              {justSaved && (
                <span className="text-sm text-emerald-700">{t("exchangeRate.justSaved")}</span>
              )}
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t("exchangeRate.historyTitle")}
          subtitle={historySubtitle}
        />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">{t("exchangeRate.colEffectiveDate")}</th>
                <th className="px-5 py-2 font-medium">{t("exchangeRate.colRate")}</th>
                <th className="px-5 py-2 font-medium">{t("exchangeRate.colSource")}</th>
                <th className="px-5 py-2 font-medium">{t("exchangeRate.colNotes")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-6 text-center text-sm text-slate-500">
                    {t("exchangeRate.historyEmpty")}
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
  const { t } = useTranslation();

  if (status === "none") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">
          {t("exchangeRate.statusNoneTitle")}
        </p>
        <p className="mt-1 text-xs text-amber-800">
          {t("exchangeRate.statusNoneBody")}
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
              {t("exchangeRate.statusCurrentTitle")}
            </p>
            <p className="mt-1 text-xs text-emerald-800">
              {t("exchangeRate.statusCurrentBody")}
            </p>
          </div>
          <div className="text-end">
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
              {t("exchangeRate.statusStaleTitle", { relative: relativeFromToday(current.effectiveDate) })}
            </p>
            <p className="mt-1 text-xs text-orange-800">
              {t("exchangeRate.statusStaleBody")}
              {days >= 3 && ` ${t("exchangeRate.statusStaleDays")}`}
            </p>
          </div>
          <div className="text-end">
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
