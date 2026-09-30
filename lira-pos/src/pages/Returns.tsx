import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { creditMemosRepo } from "../db/repos/creditMemos";
import { query } from "../db/client";
import type { CreditMemo, CreditMemoWithDetails } from "../db/types";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { CreditMemoPrint } from "../components/CreditMemoPrint";
import { formatUsd } from "../lib/money";
import { formatPrettyDate } from "../lib/dates";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

interface MemoListItem {
  memo: CreditMemo;
  originalReceiptNumber: number | null;
}

function isoToLocalDate(iso: string): string {
  return iso.slice(0, 10);
}

export default function Returns() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [storeName, setStoreName] = useState("Store");
  const [items, setItems] = useState<MemoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CreditMemoWithDetails | null>(null);
  const [detailReceiptNumber, setDetailReceiptNumber] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!storeId || !hydrated) return;
    query<{ name: string }>("SELECT name FROM stores WHERE id = ? LIMIT 1", [storeId])
      .then((rows) => {
        if (rows[0]) setStoreName(rows[0].name);
      })
      .catch(() => {});
  }, [storeId, hydrated]);

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setItems(await creditMemosRepo.listByStoreWithSale(storeId, 200));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) void reload();
  }, [hydrated, reload]);

  async function openDetail(item: MemoListItem) {
    if (selectedId === item.memo.id && detail) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(item.memo.id);
    setDetail(null);
    setDetailReceiptNumber(item.originalReceiptNumber);
    setDetailLoading(true);
    try {
      setDetail(await creditMemosRepo.findByIdWithDetails(item.memo.id));
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  const summary = useMemo(() => {
    const refunded = items
      .filter((i) => i.memo.status === "posted")
      .reduce((s, i) => s + i.memo.refundTotalUsdCents, 0);
    return { refunded, count: items.length };
  }, [items]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const cardSubtitle = loading
    ? t("common.loading")
    : t(items.length === 1 ? "returns.countOne" : "returns.countMany", {
        count: String(items.length),
      });

  return (
    <div className="space-y-6">
      <PageHeader title={t("returns.listTitle")} subtitle={t("returns.listSubtitle")} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard label={t("returns.colRefunded")} value={formatUsd(summary.refunded)} />
        <StatCard label={t("returns.listCardTitle")} value={String(summary.count)} />
      </div>

      <Card>
        <CardHeader title={t("returns.listCardTitle")} subtitle={cardSubtitle} />

        {loadError && (
          <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
            {t("returns.loadFailed", { error: loadError })}
          </div>
        )}

        {items.length === 0 && !loading && !loadError ? (
          <EmptyState title={t("returns.listEmpty")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">{t("returns.colMemo")}</th>
                  <th className="px-5 py-2">{t("returns.colOriginalSale")}</th>
                  <th className="px-5 py-2">{t("returns.colDate")}</th>
                  <th className="px-5 py-2 text-end">{t("returns.colRefunded")}</th>
                  <th className="px-5 py-2">{t("returns.colStatus")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => {
                  const m = item.memo;
                  const dateIso = m.postedAt ?? m.createdAt;
                  return (
                    <tr
                      key={m.id}
                      className={clsx(
                        "cursor-pointer transition-colors hover:bg-slate-50",
                        selectedId === m.id && "bg-brand/5",
                      )}
                      onClick={() => void openDetail(item)}
                    >
                      <td className="px-5 py-2 font-medium text-slate-900">
                        #{m.creditMemoNumber}
                      </td>
                      <td className="px-5 py-2 text-slate-700">
                        {item.originalReceiptNumber != null ? `#${item.originalReceiptNumber}` : "—"}
                      </td>
                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(isoToLocalDate(dateIso))}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(m.refundTotalUsdCents)}
                      </td>
                      <td className="px-5 py-2">
                        <Badge
                          tone={m.status === "posted" ? "good" : "neutral"}
                          className={clsx(m.status === "voided" && "line-through")}
                        >
                          {m.status === "posted"
                            ? t("returns.statusPosted")
                            : t("returns.statusVoided")}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId && (
        <>
          <div
            className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-sm print:hidden"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
            }}
          />
          <div className="fixed inset-y-0 end-0 z-50 w-[480px] max-w-[80vw] animate-fade-in overflow-y-auto border-s border-slate-200 bg-white shadow-2xl print:hidden">
            <Card>
              <CardHeader
                title={
                  detail
                    ? t("returns.detailTitle", { number: String(detail.creditMemoNumber) })
                    : t("returns.creditMemoLabel")
                }
                actions={
                  <>
                    {detail && (
                      <Button variant="ghost" size="sm" onClick={() => window.print()}>
                        {t("returns.printCreditMemo")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedId(null);
                        setDetail(null);
                      }}
                    >
                      {t("common.close")}
                    </Button>
                  </>
                }
              />
              <CardBody>
                {detailLoading ? (
                  <p className="text-sm text-slate-500">{t("common.loading")}</p>
                ) : detail ? (
                  <div className="flex justify-center">
                    <CreditMemoPrint
                      memo={detail}
                      storeName={storeName}
                      originalReceiptNumber={detailReceiptNumber}
                    />
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </div>
        </>
      )}

      {/* Print-only root */}
      {detail && (
        <div id="credit-memo-print-root" className="hidden print:block">
          <CreditMemoPrint
            memo={detail}
            storeName={storeName}
            originalReceiptNumber={detailReceiptNumber}
          />
        </div>
      )}
    </div>
  );
}
