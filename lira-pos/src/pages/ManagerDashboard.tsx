import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { reportsRepo, type DailySalesRow, type DailyReturnsRow } from "../db/repos/reports";
import { mergeProductRows } from "../lib/reportMath";
import { formatUsd } from "../lib/money";
import { formatPrettyDate, todayLocalDate } from "../lib/dates";
import { useTranslation } from "../lib/i18n";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import clsx from "clsx";

/**
 * MANAGER / OWNER DASHBOARD (V1.1).
 *
 * Restaurant-wide: every posted sale of the store, whoever rang it up. Built
 * ONLY from the report series Local Reports already uses, so the two screens
 * cannot disagree:
 *
 *   * Gross sales = posted sales INCLUDING VAT, before returns (`dailySales`).
 *   * Refunds     = posted credit memos INCLUDING VAT (`dailyReturns`) —
 *                   their own documents, never netted into the sales series.
 *   * Net sales   = gross − refunds, shown as that subtraction.
 *   * Average ticket = gross ÷ receipts.
 *
 * No cost, COGS or margin appears here, so nothing on this screen depends on
 * `ReadCostAndMargin`; the screen itself is offered to the supervisory roles
 * only (`permissions.ts`).
 */

type Range = "today" | "7d" | "30d" | "custom";

function shiftDate(local: string, days: number): string {
  const [y, m, d] = local.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  for (let i = 0; i < 400 && d <= to; i++) {
    out.push(d);
    d = shiftDate(d, 1);
  }
  return out;
}

export default function ManagerDashboard() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();
  const today = todayLocalDate();

  const [range, setRange] = useState<Range>("7d");
  const [customFrom, setCustomFrom] = useState(shiftDate(today, -6));
  const [customTo, setCustomTo] = useState(today);

  const { dateFrom, dateTo } = useMemo(() => {
    if (range === "today") return { dateFrom: today, dateTo: today };
    if (range === "7d") return { dateFrom: shiftDate(today, -6), dateTo: today };
    if (range === "30d") return { dateFrom: shiftDate(today, -29), dateTo: today };
    const a = customFrom <= customTo ? customFrom : customTo;
    const b = customFrom <= customTo ? customTo : customFrom;
    return { dateFrom: a, dateTo: b };
  }, [range, today, customFrom, customTo]);

  const [sales, setSales] = useState<DailySalesRow[]>([]);
  const [returns, setReturns] = useState<DailyReturnsRow[]>([]);
  const [products, setProducts] = useState<{ name: string; totalCents: number; qty: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-only: a slower answer for an older range writes nothing.
  const generation = useRef(0);

  useEffect(() => {
    if (!hydrated || !storeId) return;
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    const args = { storeId, dateFrom, dateTo };
    Promise.all([
      reportsRepo.dailySales(args),
      reportsRepo.dailyReturns(args),
      reportsRepo.productSales(args),
      reportsRepo.productReturns(args),
    ])
      .then(([s, r, ps, pr]) => {
        if (gen !== generation.current) return;
        setSales(s);
        setReturns(r);
        setProducts(
          mergeProductRows(ps, pr)
            .map((p) => ({
              name: p.productName,
              totalCents: p.netRevenueInclVatCents,
              qty: p.netQty,
            }))
            .sort((a, b) => b.totalCents - a.totalCents)
            .slice(0, 8),
        );
      })
      .catch((e) => {
        if (gen !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [hydrated, storeId, dateFrom, dateTo]);

  const totals = useMemo(() => {
    const gross = sales.reduce((a, r) => a + r.totalInclVatCents, 0);
    const receipts = sales.reduce((a, r) => a + r.saleCount, 0);
    const refunds = returns.reduce((a, r) => a + r.totalInclVatCents, 0);
    const refundCount = returns.reduce((a, r) => a + r.memoCount, 0);
    return {
      gross,
      receipts,
      refunds,
      refundCount,
      net: gross - refunds,
      average: receipts > 0 ? Math.round(gross / receipts) : 0,
    };
  }, [sales, returns]);

  const days = useMemo(() => {
    const byDay = new Map(sales.map((r) => [r.localDate, r.totalInclVatCents]));
    return eachDay(dateFrom, dateTo).map((d) => ({ date: d, cents: byDay.get(d) ?? 0 }));
  }, [sales, dateFrom, dateTo]);

  if (!hydrated) return <div className="text-sm text-fg-muted">{t("common.loading")}</div>;

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: t("managerDashboard.rangeToday") },
    { id: "7d", label: t("managerDashboard.range7") },
    { id: "30d", label: t("managerDashboard.range30") },
    { id: "custom", label: t("managerDashboard.rangeCustom") },
  ];
  const empty = !loading && !error && totals.receipts === 0 && totals.refundCount === 0;

  return (
    <div className="space-y-5">
      <PageHeader title={t("managerDashboard.title")} subtitle={t("managerDashboard.subtitleAll")} />

      <div className="flex flex-wrap items-end gap-2">
        <div role="group" aria-label={t("managerDashboard.rangeLabel")} className="flex flex-wrap gap-1.5">
          {ranges.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={clsx(
                "rounded-chip border px-3 py-1.5 text-xs font-extrabold",
                range === r.id
                  ? "border-brand bg-brand text-brand-fg"
                  : "border-line bg-surface text-fg-muted hover:text-fg",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="flex items-end gap-2 text-xs">
            <label className="flex flex-col gap-1 font-semibold text-fg-muted">
              {t("managerDashboard.from")}
              <input
                type="date"
                value={customFrom}
                max={today}
                onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
                className="rounded-chip border border-line px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 font-semibold text-fg-muted">
              {t("managerDashboard.to")}
              <input
                type="date"
                value={customTo}
                max={today}
                onChange={(e) => e.target.value && setCustomTo(e.target.value)}
                className="rounded-chip border border-line px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        )}
        <span className="ms-auto text-xs text-fg-muted">
          {dateFrom === dateTo
            ? formatPrettyDate(dateFrom)
            : `${formatPrettyDate(dateFrom)} – ${formatPrettyDate(dateTo)}`}
        </span>
      </div>

      {error && (
        <div className="rounded-chip border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={t("managerDashboard.grossSales")} value={formatUsd(totals.gross)} />
        <StatCard
          label={t("managerDashboard.refunds")}
          value={formatUsd(totals.refunds)}
          tone={totals.refunds > 0 ? "warn" : undefined}
        />
        <StatCard label={t("managerDashboard.netSales")} value={formatUsd(totals.net)} />
        <StatCard label={t("managerDashboard.receipts")} value={String(totals.receipts)} />
        <StatCard label={t("managerDashboard.averageTicket")} value={formatUsd(totals.average)} />
      </div>
      <p className="text-[11px] text-fg-muted">{t("managerDashboard.definitions")}</p>

      {empty ? (
        <EmptyState title={t("managerDashboard.empty")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title={t("managerDashboard.byDay")} />
            <CardBody>
              <DayBars days={days} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t("managerDashboard.byProduct")} subtitle={t("managerDashboard.byProductNote")} />
            <CardBody>
              <ProductBars rows={products} />
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function DayBars({ days }: { days: { date: string; cents: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.cents));
  const W = 640;
  const H = 180;
  const gap = days.length > 20 ? 2 : 6;
  const bw = Math.max(2, (W - gap * (days.length - 1)) / Math.max(1, days.length));
  const labelEvery = days.length > 14 ? Math.ceil(days.length / 10) : 1;
  return (
    <svg viewBox={`0 0 ${W} ${H + 34}`} className="w-full" role="img" aria-label="Sales by day">
      {days.map((d, i) => {
        const h = Math.round((d.cents / max) * H);
        const x = i * (bw + gap);
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${formatUsd(d.cents)}`}</title>
            <rect
              x={x}
              y={H - h}
              width={bw}
              height={Math.max(h, d.cents > 0 ? 1 : 0)}
              rx={2}
              className="fill-brand"
            />
            {i % labelEvery === 0 && (
              <text x={x + bw / 2} y={H + 14} textAnchor="middle" className="fill-fg-muted text-[10px]">
                {d.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} x2={W} y1={H} y2={H} className="stroke-line" />
      <text x={W} y={H + 30} textAnchor="end" className="fill-fg-muted text-[10px]">
        {`max ${formatUsd(max)}`}
      </text>
    </svg>
  );
}

function ProductBars({ rows }: { rows: { name: string; totalCents: number; qty: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.totalCents));
  if (rows.length === 0) return <p className="text-sm text-fg-muted">—</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.name} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate font-semibold text-fg" title={r.name}>
            {r.name}
          </span>
          <span className="h-3 rounded-full bg-paper">
            <span
              className="block h-3 rounded-full bg-brand"
              style={{ width: `${Math.max(2, Math.round((r.totalCents / max) * 100))}%` }}
            />
          </span>
          <span className="tabular-nums text-fg">
            {formatUsd(r.totalCents)} · {r.qty}
          </span>
        </li>
      ))}
    </ul>
  );
}
