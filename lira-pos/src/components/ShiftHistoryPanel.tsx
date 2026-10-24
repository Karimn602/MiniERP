import { useCallback, useEffect, useRef, useState } from "react";
import {
  shiftsRepo,
  type ShiftHistoryRow,
  type ShiftHistoryDetail,
} from "../db/repos/shifts";
import type { PaymentMethod } from "../db/types";
import { Card, CardHeader, CardBody } from "./ui/Card";
import { Button } from "./ui/Button";
import { formatUsd, formatLbp } from "../lib/money";
import { useTranslation } from "../lib/i18n";
import { todayLocalDate } from "../lib/dates";
import clsx from "clsx";

/**
 * SHIFT HISTORY (WP-A1) — the shifts this store has already closed, and the
 * reconciliation each of them was closed on.
 *
 * ## Why this screen exists
 *
 * Every figure here has been in the database since migration 001, and none of
 * it was reachable. The Shift screen showed the OPEN shift or the form to open
 * one; the moment a cashier closed a shift, the counted cash, the expected
 * cash and the variance they were held to left the visible application. A
 * number that is stored but unreadable is not an audit trail, and "what was
 * last night's variance?" was a question only a SQL client could answer.
 *
 * ## The one rule this screen must not break
 *
 * A CLOSED SHIFT'S RECONCILIATION IS A HISTORICAL STATEMENT, NOT A LIVE
 * CALCULATION.
 *
 * `close_shift` computes `expected_cash_usd_cents`, `expected_cash_lbp` and
 * both variances INSIDE the transaction that marks the shift closed, writes
 * them once, and migration 009's `trg_shifts_no_update_after_close` then makes
 * them immutable. So this screen READS those columns for a closed shift. It
 * does not re-derive them, average them, or correct them — not from today's
 * exchange rate (which would restate a drawer that was counted in notes), and
 * not from the current drawer formula either.
 *
 * That last point is the subtle one and it is why the recomputation is shown
 * at all. The expected-cash formula has changed twice in this codebase's life:
 * WP-06 added cash refunds out, WP-7 added driver remittances in. A shift
 * closed before either change was closed, correctly, on the formula of its
 * day. Recomputing it now would silently rewrite history into a variance the
 * cashier was never shown. So the panel states the RECORDED figure as
 * authoritative, and when today's components do not reproduce it, says so in
 * a line of its own rather than choosing one of the two numbers and hiding
 * the disagreement.
 *
 * For the OPEN shift there is nothing recorded yet, so the live figure IS the
 * answer and is labelled as a running total.
 *
 * ## Read-only by construction
 *
 * Nothing here writes. There is no edit control, no re-close, no recompute
 * button — and no guard is needed for that, because a closed shift cannot be
 * written by any caller: the trigger refuses it.
 */

// ---------- Helpers ----------

function formatLocalDateTime(isoUtc: string): string {
  return new Date(isoUtc).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatLocalTime(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString(undefined, { timeStyle: "short" });
}

/** A signed variance, with its sign spelled out. */
function varianceLabel(
  value: number | null,
  format: (n: number) => string,
  exactLabel: string,
): string {
  if (value === null) return "—";
  if (value === 0) return exactLabel;
  return `${value > 0 ? "+" : ""}${format(value)}`;
}

function varianceTone(value: number | null): "good" | "warn" | "muted" {
  if (value === null) return "muted";
  return value === 0 ? "good" : "warn";
}

function Row({
  label,
  value,
  sub,
  tone,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "muted";
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className={clsx("text-xs", strong ? "font-semibold text-fg" : "text-fg-muted")}>
          {label}
        </div>
        {sub && <div className="text-[11px] text-fg-subtle">{sub}</div>}
      </div>
      <div
        className={clsx(
          "shrink-0 tabular-nums",
          strong ? "text-sm font-bold" : "text-xs font-medium",
          tone === "good" && "text-good-fg",
          tone === "warn" && "text-warn-fg",
          tone === "muted" && "text-fg-muted",
          !tone && "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ---------- Panel ----------

export function ShiftHistoryPanel({ storeId }: { storeId: string }) {
  const { t } = useTranslation();

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rows, setRows] = useState<ShiftHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShiftHistoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /**
   * LATEST-REQUEST-ONLY, for both loaders.
   *
   * Both are async, and both are re-run by ordinary interaction: a date typed
   * into a filter, a store switched under the panel, a row clicked and then
   * another. Two answers are therefore in flight at once routinely, and
   * nothing promises they come back in the order they were asked. Writing
   * each one into state as it lands means the SLOWER of two answers wins, and
   * the panel then shows a list, or a reconciliation, belonging to a question
   * nobody is asking any more — the previous store's shifts under the new
   * store's name, yesterday's detail under the row just selected. On this
   * screen that is not a cosmetic glitch: the figures are the cash
   * reconciliation a cashier was held to.
   *
   * The mechanism is one monotonic generation per loader. A request takes the
   * next number before it awaits and compares it after; if it is no longer
   * the current number it writes NOTHING — not the rows, not the error, and
   * not the loading flag, because an old request clearing the spinner would
   * say "loaded" over a list still being fetched. The effects bump the
   * generation on cleanup, so a dependency change or an unmount retires
   * whatever is in flight and no response can reach a component that is gone.
   *
   * The identity being compared is the whole request: the generation is taken
   * inside the callback that closed over this store and these filters, so a
   * response can only be applied while the store, the filters and (for the
   * detail) the selected shift are still the ones that asked for it.
   */
  const listGenRef = useRef(0);
  const detailGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++listGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await shiftsRepo.listHistory({
        storeId,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      if (listGenRef.current !== gen) return;
      setRows(next);
    } catch (e) {
      if (listGenRef.current !== gen) return;
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      if (listGenRef.current === gen) setLoading(false);
    }
  }, [storeId, fromDate, toDate]);

  useEffect(() => {
    void load();
    return () => {
      // The deps changed or the panel is unmounting; either way this run's
      // answer is no longer wanted.
      listGenRef.current++;
    };
  }, [load]);

  /**
   * A new store, or a new filter window, retires the open detail.
   *
   * The expanded row belongs to the list that was on screen when it was
   * clicked, and after the question changes that shift may not be in the
   * answer at all. Without this, a detail response still in flight would land
   * under the new list as though it belonged to it — which is exactly the
   * "previous store's history" case, one level down.
   */
  useEffect(() => {
    detailGenRef.current++;
    setOpenId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, [storeId, fromDate, toDate]);

  /** Unmount retires an in-flight detail, for the same reason as the list. */
  useEffect(
    () => () => {
      detailGenRef.current++;
    },
    [],
  );

  const openDetail = useCallback(
    async (shiftId: string) => {
      if (openId === shiftId) {
        // Collapsing is a decision too: the answer for the row just closed
        // must not reopen it half a second later.
        detailGenRef.current++;
        setOpenId(null);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
        return;
      }
      const gen = ++detailGenRef.current;
      setOpenId(shiftId);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const d = await shiftsRepo.getHistoryDetail(shiftId, storeId);
        if (detailGenRef.current !== gen) return;
        if (!d) {
          setDetailError(t("shiftHistory.notFound"));
          return;
        }
        setDetail(d);
      } catch (e) {
        if (detailGenRef.current !== gen) return;
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        if (detailGenRef.current === gen) setDetailLoading(false);
      }
    },
    [openId, storeId, t],
  );

  return (
    <div className="space-y-4">
      {/* Filters. On the local calendar date the shift was OPENED — see
          `listHistory` for why opened rather than closed. */}
      <Card>
        <CardHeader
          title={t("shiftHistory.title")}
          subtitle={t("shiftHistory.subtitle")}
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-fg-muted">
              {t("shiftHistory.filterFrom")}
              <input
                type="date"
                value={fromDate}
                max={toDate || todayLocalDate()}
                onChange={(e) => setFromDate(e.target.value)}
                className="mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
              />
            </label>
            <label className="text-xs font-medium text-fg-muted">
              {t("shiftHistory.filterTo")}
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
              />
            </label>
            <Button
              variant="ghost"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
              disabled={fromDate === "" && toDate === ""}
            >
              {t("shiftHistory.filterClear")}
            </Button>
            <Button variant="ghost" onClick={() => void load()} disabled={loading}>
              {t("common.refresh")}
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      <Card>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-fg-muted">
            {t("shiftHistory.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-fg-muted">
            {t("shiftHistory.none")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line bg-paper text-start text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start">{t("shiftHistory.colOpened")}</th>
                  <th className="px-4 py-2 text-start">{t("shiftHistory.colClosed")}</th>
                  <th className="px-4 py-2 text-start">{t("shiftHistory.colCashier")}</th>
                  <th className="px-4 py-2 text-end">{t("shiftHistory.colExpectedUsd")}</th>
                  <th className="px-4 py-2 text-end">{t("shiftHistory.colCountedUsd")}</th>
                  <th className="px-4 py-2 text-end">{t("shiftHistory.colVarianceUsd")}</th>
                  <th className="px-4 py-2 text-start">{t("shiftHistory.colStatus")}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(({ shift, openedByName, closedByName }) => {
                  const isOpen = shift.status === "open";
                  return (
                    <tr
                      key={shift.id}
                      className={clsx(
                        "cursor-pointer hover:bg-paper",
                        openId === shift.id && "bg-paper",
                      )}
                      onClick={() => void openDetail(shift.id)}
                    >
                      <td className="px-4 py-2 font-medium text-fg">
                        {formatLocalDateTime(shift.openedAt)}
                      </td>
                      <td className="px-4 py-2 text-fg-muted">
                        {shift.closedAt ? formatLocalDateTime(shift.closedAt) : "—"}
                      </td>
                      <td className="px-4 py-2 text-fg-muted">
                        {openedByName ?? "—"}
                        {closedByName && closedByName !== openedByName
                          ? ` → ${closedByName}`
                          : ""}
                      </td>
                      {/* The RECORDED figures. Blank for an open shift, which
                          is the honest answer: nothing has been reconciled
                          yet, and printing a running total in a column headed
                          "expected at close" would read as a closed figure. */}
                      <td className="px-4 py-2 text-end tabular-nums text-fg">
                        {shift.expectedCashUsdCents === null
                          ? "—"
                          : formatUsd(shift.expectedCashUsdCents)}
                      </td>
                      <td className="px-4 py-2 text-end tabular-nums text-fg">
                        {shift.closingCashUsdCents === null
                          ? "—"
                          : formatUsd(shift.closingCashUsdCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-4 py-2 text-end tabular-nums font-medium",
                          varianceTone(shift.varianceUsdCents) === "good" && "text-good-fg",
                          varianceTone(shift.varianceUsdCents) === "warn" && "text-warn-fg",
                          varianceTone(shift.varianceUsdCents) === "muted" && "text-fg-muted",
                        )}
                      >
                        {varianceLabel(
                          shift.varianceUsdCents,
                          formatUsd,
                          t("shift.exact"),
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={clsx(
                            "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
                            isOpen
                              ? "bg-good-bg text-good-fg"
                              : shift.status === "voided"
                                ? "bg-danger-bg text-danger-fg"
                                : "bg-paper text-fg-muted",
                          )}
                        >
                          {t(`shiftHistory.status.${shift.status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-end text-xs font-semibold text-brand-ink">
                        {openId === shift.id
                          ? t("shiftHistory.hide")
                          : t("shiftHistory.view")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId && (
        <>
          {detailLoading && (
            <div className="text-sm text-fg-muted">{t("shiftHistory.loadingDetail")}</div>
          )}
          {detailError && (
            <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
              {detailError}
            </div>
          )}
          {detail && <ShiftDetail detail={detail} />}
        </>
      )}
    </div>
  );
}

// ---------- One shift, in full ----------

function ShiftDetail({ detail }: { detail: ShiftHistoryDetail }) {
  const { t } = useTranslation();
  const { row, sales, payments, refunds, refundRows, drawer } = detail;
  const shift = row.shift;
  const closed = shift.status !== "open";

  /**
   * The drawer figure TODAY'S formula produces from the rows this shift
   * holds — a cross-check, never the answer.
   *
   * `opening float + cash in + driver remittances in − change out − cash
   * refunds out`, per currency, in each currency's own unit: exactly
   * `posting.rs::drawer_cash_for_shift`, which is what `close_shift` wrote
   * and what the live Current Shift view previews. No exchange rate is
   * involved in either currency's figure, so this cannot drift with the rate.
   *
   * For a CLOSED shift the recorded column wins. See the module header.
   */
  const recomputedUsd =
    shift.openingCashUsdCents +
    drawer.cashUsdInCents +
    drawer.driverRemitUsdInCents -
    drawer.changeUsdOutCents -
    drawer.refundUsdOutCents;
  const recomputedLbp =
    shift.openingCashLbp +
    drawer.cashLbpIn +
    drawer.driverRemitLbpIn -
    drawer.changeLbpOut -
    drawer.refundLbpOut;

  const expectedUsd = closed ? shift.expectedCashUsdCents : recomputedUsd;
  const expectedLbp = closed ? shift.expectedCashLbp : recomputedLbp;

  // A closed shift whose recorded expectation does not match what today's
  // formula makes of its rows. Reported, not reconciled: see the header.
  const usdDiffers =
    closed &&
    shift.expectedCashUsdCents !== null &&
    shift.expectedCashUsdCents !== recomputedUsd;
  const lbpDiffers =
    closed && shift.expectedCashLbp !== null && shift.expectedCashLbp !== recomputedLbp;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t("shiftHistory.detailTitle", {
            date: formatLocalDateTime(shift.openedAt),
          })}
          subtitle={
            closed
              ? t("shiftHistory.detailClosedAt", {
                  time: shift.closedAt ? formatLocalDateTime(shift.closedAt) : "—",
                })
              : t("shiftHistory.detailStillOpen")
          }
        />
        <CardBody className="space-y-4">
          {/* Identification. The id is shown because it is what a support
              question or a SQL check is keyed on, and nothing else on screen
              identifies a shift uniquely — two shifts can open at the same
              minute on two days. */}
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <div className="divide-y divide-line">
              <Row label={t("shiftHistory.shiftId")} value={shift.id} />
              <Row
                label={t("shiftHistory.openedBy")}
                value={row.openedByName ?? t("shiftHistory.unknownUser")}
                sub={formatLocalDateTime(shift.openedAt)}
              />
              <Row
                label={t("shiftHistory.closedBy")}
                value={
                  closed
                    ? (row.closedByName ?? t("shiftHistory.unknownUser"))
                    : t("shiftHistory.notClosedYet")
                }
                sub={shift.closedAt ? formatLocalDateTime(shift.closedAt) : undefined}
              />
            </div>
            <div className="divide-y divide-line">
              <Row
                label={`${t("shift.openingCash")} · ${t("shift.usdLabel")}`}
                value={formatUsd(shift.openingCashUsdCents)}
              />
              <Row
                label={`${t("shift.openingCash")} · ${t("shift.lbpLabel")}`}
                value={formatLbp(shift.openingCashLbp)}
              />
              <Row
                label={t("shiftHistory.colStatus")}
                value={t(`shiftHistory.status.${shift.status}`)}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Sales. The same definitions the live view uses — post-discount,
          BEFORE returns — so the two screens cannot mean different things by
          "net sales". */}
      <Card>
        <CardHeader title={t("shift.salesCollection")} />
        <CardBody>
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <div className="divide-y divide-line">
              <Row label={t("shift.receipts")} value={String(sales.receiptCount)} />
              <Row
                label={t("shift.salesInclVat")}
                value={formatUsd(sales.totalInclVatCents)}
              />
              <Row
                label={t("shift.netExclVat")}
                value={formatUsd(sales.subtotalExclVatCents)}
                sub={t("shift.afterDiscounts")}
              />
            </div>
            <div className="divide-y divide-line">
              <Row
                label={t("shift.outputVat")}
                value={formatUsd(sales.vatTotalCents)}
                sub={t("shift.owedToAuthority")}
              />
              <Row
                label={t("shift.discounts")}
                value={formatUsd(sales.discountCents)}
                tone={sales.discountCents > 0 ? "warn" : undefined}
              />
              <Row
                label={t("shift.returnsCount")}
                value={String(refunds.memoCount)}
                sub={
                  refunds.totalInclVatCents > 0
                    ? `${t("shift.refundsInclVat")}: ${formatUsd(refunds.totalInclVatCents)}`
                    : undefined
                }
                tone={refunds.totalInclVatCents > 0 ? "warn" : undefined}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Payment methods. Native amount AND USD equivalent, because the
          equivalent was computed at the rate the sale locked and is the only
          figure the two currencies can be added in. */}
      <Card>
        <CardHeader title={t("shift.paymentBreakdownTitle")} />
        {payments.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-fg-muted">
            {t("shift.noPaymentsYet")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line bg-paper text-start text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start">{t("shift.colMethod")}</th>
                  <th className="px-4 py-2 text-end">{t("shift.colNativeAmount")}</th>
                  <th className="px-4 py-2 text-end">{t("shift.colUsdEquivalent")}</th>
                  <th className="px-4 py-2 text-end">{t("shift.colChangeGiven")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {payments.map((p) => (
                  <tr key={`${p.method}-${p.currency}`}>
                    <td className="px-4 py-2 font-medium text-fg">
                      {t(`shift.paymentMethods.${p.method as PaymentMethod}`)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums text-fg-muted">
                      {p.currency === "LBP"
                        ? formatLbp(p.amountNativeLbp)
                        : formatUsd(p.amountNativeUsdCents)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums text-fg">
                      {formatUsd(p.amountUsdCentsEquivalent)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums text-fg-muted">
                      {p.changeGivenUsdCents > 0 || p.changeGivenLbp > 0
                        ? [
                            p.changeGivenUsdCents > 0 ? formatUsd(p.changeGivenUsdCents) : null,
                            p.changeGivenLbp > 0 ? formatLbp(p.changeGivenLbp) : null,
                          ]
                            .filter(Boolean)
                            .join(" + ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {refundRows.length > 0 && (
        <Card>
          <CardHeader
            title={t("shift.refundBreakdownTitle")}
            subtitle={t("shift.refundBreakdownSubtitle")}
          />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line bg-paper text-start text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start">{t("shift.colMethod")}</th>
                  <th className="px-4 py-2 text-end">{t("shift.colNativeAmount")}</th>
                  <th className="px-4 py-2 text-end">{t("shift.colUsdEquivalent")}</th>
                  <th className="px-4 py-2 text-start">{t("shift.colTouchesDrawer")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {refundRows.map((r) => (
                  <tr key={`${r.method}-${r.currency}`}>
                    <td className="px-4 py-2 font-medium text-fg">
                      {t(`shift.paymentMethods.${r.method as PaymentMethod}`)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums text-fg-muted">
                      {r.currency === "LBP"
                        ? formatLbp(r.amountNativeLbp)
                        : formatUsd(r.amountNativeUsdCents)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums text-fg">
                      {formatUsd(r.amountUsdCentsEquivalent)}
                    </td>
                    <td className="px-4 py-2 text-xs text-fg-muted">
                      {r.method === "cash_usd" || r.method === "cash_lbp"
                        ? t("shift.drawerYes")
                        : t("shift.drawerNo")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* The drawer. The RECORDED reconciliation for a closed shift; a running
          total for the open one. */}
      <Card>
        <CardHeader
          title={t("shift.cashDrawerTitle")}
          subtitle={
            closed
              ? t("shiftHistory.drawerRecorded")
              : t("shiftHistory.drawerRunning")
          }
        />
        <CardBody>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {/* USD */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {t("shift.usdLabel")}
              </div>
              <div className="divide-y divide-line">
                <Row
                  label={t("shift.openingCash")}
                  value={formatUsd(shift.openingCashUsdCents)}
                />
                <Row
                  label={t("shift.cashReceived")}
                  value={formatUsd(drawer.cashUsdInCents)}
                />
                <Row
                  label={t("shift.driverRemittances")}
                  value={formatUsd(drawer.driverRemitUsdInCents)}
                />
                <Row
                  label={t("shift.changeGiven")}
                  value={
                    drawer.changeUsdOutCents > 0
                      ? `− ${formatUsd(drawer.changeUsdOutCents)}`
                      : "—"
                  }
                  tone={drawer.changeUsdOutCents > 0 ? "warn" : undefined}
                />
                <Row
                  label={t("shift.cashRefunded")}
                  value={
                    drawer.refundUsdOutCents > 0
                      ? `− ${formatUsd(drawer.refundUsdOutCents)}`
                      : "—"
                  }
                  tone={drawer.refundUsdOutCents > 0 ? "warn" : undefined}
                />
                <Row
                  label={t("shift.expectedInDrawer")}
                  value={expectedUsd === null ? "—" : formatUsd(expectedUsd)}
                  sub={
                    closed
                      ? t("shiftHistory.asRecorded")
                      : t("shiftHistory.asRunning")
                  }
                  strong
                />
                <Row
                  label={t("shiftHistory.countedCash")}
                  value={
                    shift.closingCashUsdCents === null
                      ? "—"
                      : formatUsd(shift.closingCashUsdCents)
                  }
                  strong
                />
                <Row
                  label={t("shift.variance")}
                  value={varianceLabel(
                    shift.varianceUsdCents,
                    formatUsd,
                    t("shift.exact"),
                  )}
                  tone={varianceTone(shift.varianceUsdCents)}
                  strong
                />
              </div>
              {usdDiffers && (
                <p className="mt-2 text-[11px] leading-snug text-warn-fg">
                  {t("shiftHistory.recomputedDiffers", {
                    recomputed: formatUsd(recomputedUsd),
                  })}
                </p>
              )}
            </div>

            {/* LBP */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {t("shift.lbpLabel")}
              </div>
              <div className="divide-y divide-line">
                <Row
                  label={t("shift.openingCash")}
                  value={formatLbp(shift.openingCashLbp)}
                />
                <Row label={t("shift.cashReceived")} value={formatLbp(drawer.cashLbpIn)} />
                <Row
                  label={t("shift.driverRemittances")}
                  value={formatLbp(drawer.driverRemitLbpIn)}
                />
                <Row
                  label={t("shift.changeGiven")}
                  value={
                    drawer.changeLbpOut > 0 ? `− ${formatLbp(drawer.changeLbpOut)}` : "—"
                  }
                  tone={drawer.changeLbpOut > 0 ? "warn" : undefined}
                />
                <Row
                  label={t("shift.cashRefunded")}
                  value={
                    drawer.refundLbpOut > 0 ? `− ${formatLbp(drawer.refundLbpOut)}` : "—"
                  }
                  tone={drawer.refundLbpOut > 0 ? "warn" : undefined}
                />
                <Row
                  label={t("shift.expectedInDrawer")}
                  value={expectedLbp === null ? "—" : formatLbp(expectedLbp)}
                  sub={
                    closed
                      ? t("shiftHistory.asRecorded")
                      : t("shiftHistory.asRunning")
                  }
                  strong
                />
                <Row
                  label={t("shiftHistory.countedCash")}
                  value={
                    shift.closingCashLbp === null ? "—" : formatLbp(shift.closingCashLbp)
                  }
                  strong
                />
                <Row
                  label={t("shift.variance")}
                  value={varianceLabel(shift.varianceLbp, formatLbp, t("shift.exact"))}
                  tone={varianceTone(shift.varianceLbp)}
                  strong
                />
              </div>
              {lbpDiffers && (
                <p className="mt-2 text-[11px] leading-snug text-warn-fg">
                  {t("shiftHistory.recomputedDiffers", {
                    recomputed: formatLbp(recomputedLbp),
                  })}
                </p>
              )}
            </div>
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-snug text-fg-muted">
            {closed ? t("shiftHistory.readOnlyNote") : t("shiftHistory.openNote")}
          </p>
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-2 print:hidden">
        <Button variant="secondary" onClick={() => window.print()}>
          {t("shiftHistory.print")}
        </Button>
      </div>

      {/* The printable copy. Fed by the SAME `detail` object the screen is
          rendering, so a printed report cannot say something the screen does
          not — and the recorded-vs-recomputed distinction above survives onto
          paper rather than being quietly resolved for the printer. */}
      <div id="shift-report-print-root" className="hidden print:block">
        <ShiftReportPrint detail={detail} />
      </div>
    </div>
  );
}

// ---------- The printed report ----------

/**
 * One shift, on paper.
 *
 * Narrow and monospaced like the receipt, because it goes to the same thermal
 * printer the shop already has — "using existing facilities" rather than
 * asking the owner to buy an A4 printer for a nightly cash-up sheet.
 *
 * Every figure is read from the same `ShiftHistoryDetail` the screen shows.
 * The counted / expected / variance block is the RECORDED one for a closed
 * shift, for the reason the module header gives.
 */
function ShiftReportPrint({ detail }: { detail: ShiftHistoryDetail }) {
  const { t } = useTranslation();
  const { row, sales, payments, refunds, drawer } = detail;
  const shift = row.shift;
  const closed = shift.status !== "open";

  const line = (label: string, value: string) => (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );

  return (
    <div id="shift-report-print" className="w-72 p-4 font-mono text-xs text-slate-900">
      <div className="mb-2 text-center">
        <div className="text-sm font-bold uppercase">{t("shiftHistory.printTitle")}</div>
        <div className="mt-0.5">{formatLocalDateTime(shift.openedAt)}</div>
        <div className="text-slate-600">
          {shift.closedAt ? `→ ${formatLocalTime(shift.closedAt)}` : t("shiftHistory.detailStillOpen")}
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      <div className="space-y-0.5">
        {line(t("shiftHistory.openedBy"), row.openedByName ?? "—")}
        {line(t("shiftHistory.closedBy"), closed ? (row.closedByName ?? "—") : "—")}
        {line(t("shift.receipts"), String(sales.receiptCount))}
        {line(t("shift.salesInclVat"), formatUsd(sales.totalInclVatCents))}
        {line(t("shift.netExclVat"), formatUsd(sales.subtotalExclVatCents))}
        {line(t("shift.outputVat"), formatUsd(sales.vatTotalCents))}
        {line(t("shift.discounts"), formatUsd(sales.discountCents))}
        {line(t("shift.returnsCount"), String(refunds.memoCount))}
        {line(t("shift.refundsInclVat"), formatUsd(refunds.totalInclVatCents))}
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      <div className="space-y-0.5">
        {payments.map((p) => (
          <div key={`${p.method}-${p.currency}`}>
            {line(
              t(`shift.paymentMethods.${p.method as PaymentMethod}`),
              p.currency === "LBP"
                ? formatLbp(p.amountNativeLbp)
                : formatUsd(p.amountNativeUsdCents),
            )}
          </div>
        ))}
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      {/* USD drawer */}
      <div className="space-y-0.5">
        <div className="font-bold">{t("shift.usdLabel")}</div>
        {line(t("shift.openingCash"), formatUsd(shift.openingCashUsdCents))}
        {line(t("shift.cashReceived"), formatUsd(drawer.cashUsdInCents))}
        {line(t("shift.driverRemittances"), formatUsd(drawer.driverRemitUsdInCents))}
        {line(t("shift.changeGiven"), `− ${formatUsd(drawer.changeUsdOutCents)}`)}
        {line(t("shift.cashRefunded"), `− ${formatUsd(drawer.refundUsdOutCents)}`)}
        {line(
          t("shift.expectedInDrawer"),
          shift.expectedCashUsdCents === null
            ? "—"
            : formatUsd(shift.expectedCashUsdCents),
        )}
        {line(
          t("shiftHistory.countedCash"),
          shift.closingCashUsdCents === null ? "—" : formatUsd(shift.closingCashUsdCents),
        )}
        <div className="flex justify-between gap-2 font-bold">
          <span>{t("shift.variance")}</span>
          <span className="tabular-nums">
            {varianceLabel(shift.varianceUsdCents, formatUsd, t("shift.exact"))}
          </span>
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      {/* LBP drawer */}
      <div className="space-y-0.5">
        <div className="font-bold">{t("shift.lbpLabel")}</div>
        {line(t("shift.openingCash"), formatLbp(shift.openingCashLbp))}
        {line(t("shift.cashReceived"), formatLbp(drawer.cashLbpIn))}
        {line(t("shift.driverRemittances"), formatLbp(drawer.driverRemitLbpIn))}
        {line(t("shift.changeGiven"), `− ${formatLbp(drawer.changeLbpOut)}`)}
        {line(t("shift.cashRefunded"), `− ${formatLbp(drawer.refundLbpOut)}`)}
        {line(
          t("shift.expectedInDrawer"),
          shift.expectedCashLbp === null ? "—" : formatLbp(shift.expectedCashLbp),
        )}
        {line(
          t("shiftHistory.countedCash"),
          shift.closingCashLbp === null ? "—" : formatLbp(shift.closingCashLbp),
        )}
        <div className="flex justify-between gap-2 font-bold">
          <span>{t("shift.variance")}</span>
          <span className="tabular-nums">
            {varianceLabel(shift.varianceLbp, formatLbp, t("shift.exact"))}
          </span>
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      <div className="text-[9px] leading-tight text-slate-600">
        {closed ? t("shiftHistory.readOnlyNote") : t("shiftHistory.openNote")}
      </div>
      <div className="mt-1 text-center text-[9px] text-slate-600">{shift.id}</div>
    </div>
  );
}
