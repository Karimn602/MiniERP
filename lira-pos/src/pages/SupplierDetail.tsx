import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useActiveContext } from "../state/activeContext";
import { suppliersRepo } from "../db/repos/suppliers";
import { supplierLedgerRepo } from "../db/repos/supplierLedger";
import type { Supplier, SupplierLedgerEntry, LedgerEntryType } from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { formatUsd, parseUsdInput } from "../lib/money";
import { todayLocalDate } from "../lib/dates";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const { storeId, userId } = useActiveContext();
  const { t } = useTranslation();

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [entries, setEntries] = useState<SupplierLedgerEntry[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;

    setLoading(true);

    try {
      const [s, es, bal] = await Promise.all([
        suppliersRepo.findById(id),
        supplierLedgerRepo.listForSupplier(id, 500),
        supplierLedgerRepo.getBalance(id),
      ]);

      setSupplier(s);
      setEntries(es);
      setBalance(bal);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return <div className="text-sm text-slate-500">{t("supplierDetail.loading")}</div>;
  }

  if (!supplier) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-slate-600">{t("supplierDetail.notFound")}</p>
        <Link to="/suppliers" className="text-sm text-brand underline">
          {t("supplierDetail.backToSuppliers")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/suppliers" className="text-xs text-brand hover:underline">
            {t("supplierDetail.allSuppliers")}
          </Link>

          <h2 className="mt-1 text-2xl font-semibold text-slate-900">
            {supplier.name}
          </h2>

          <div className="mt-1 text-xs text-slate-500">
            {supplier.contactName && <span>{supplier.contactName} · </span>}
            {supplier.phone && <span>{supplier.phone} · </span>}
            {supplier.email && <span>{supplier.email}</span>}
          </div>
        </div>

        <div className="text-end">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {t("supplierDetail.balanceOwed")}
          </div>

          <div
            className={clsx(
              "text-2xl font-semibold",
              balance > 0
                ? "text-red-700"
                : balance < 0
                  ? "text-emerald-700"
                  : "text-slate-900",
            )}
          >
            {formatUsd(balance)}
          </div>

          {balance < 0 && (
            <div className="text-[10px] text-emerald-700">{t("supplierDetail.creditOnFile")}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant={formOpen ? "ghost" : "primary"}
          onClick={() => setFormOpen((o) => !o)}
        >
          {formOpen ? t("supplierDetail.closeForm") : t("supplierDetail.recordEntry")}
        </Button>

        {justSaved && (
          <span className="text-sm text-emerald-700">{t("supplierDetail.entryPosted")}</span>
        )}
      </div>

      {formOpen && storeId && (
        <RecordEntryForm
          storeId={storeId}
          supplierId={supplier.id}
          userId={userId}
          onPosted={() => {
            setFormOpen(false);
            setJustSaved(true);
            setTimeout(() => setJustSaved(false), 3000);
            void reload();
          }}
          onCancel={() => setFormOpen(false)}
        />
      )}

      <Card>
        <CardHeader
          title={t("supplierDetail.ledgerTitle")}
          subtitle={t("supplierDetail.ledgerSubtitle")}
        />

        {entries.length === 0 ? (
          <CardBody>
            <div className="py-8 text-center text-sm text-slate-500">
              {t("supplierDetail.ledgerEmpty")}
            </div>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">{t("supplierDetail.colDate")}</th>
                  <th className="px-5 py-2 font-medium">{t("supplierDetail.colType")}</th>
                  <th className="px-5 py-2 font-medium">{t("supplierDetail.colNotes")}</th>
                  <th className="px-5 py-2 font-medium text-end">{t("supplierDetail.colAmount")}</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="px-5 py-2 text-slate-700">
                      {e.entryDate}
                    </td>

                    <td className="px-5 py-2">
                      <EntryBadge type={e.entryType} />
                    </td>

                    <td className="px-5 py-2 text-xs text-slate-600">
                      {e.notes ?? "—"}

                      {e.relatedPaymentId && (
                        <div className="text-[10px] text-slate-500">
                          {t("supplierDetail.paymentRefLabel")} {e.relatedPaymentId}
                        </div>
                      )}
                    </td>

                    <td
                      className={clsx(
                        "px-5 py-2 text-end font-medium",
                        e.amountSignedCents > 0
                          ? "text-red-700"
                          : "text-emerald-700",
                      )}
                    >
                      {e.amountSignedCents > 0 ? "+" : ""}
                      {formatUsd(e.amountSignedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function EntryBadge({ type }: { type: LedgerEntryType }) {
  const { t } = useTranslation();

  const classNames: Record<LedgerEntryType, string> = {
    purchase: "bg-slate-200 text-slate-700",
    payment: "bg-emerald-100 text-emerald-800",
    credit_note: "bg-teal-100 text-teal-800",
    opening_balance: "bg-indigo-100 text-indigo-800",
    adjustment: "bg-amber-100 text-amber-800",
  };

  return (
    <span className={clsx("rounded px-2 py-0.5 text-xs font-medium", classNames[type])}>
      {t(`supplierDetail.entryType.${type}` as Parameters<typeof t>[0])}
    </span>
  );
}

function RecordEntryForm({
  storeId,
  supplierId,
  userId,
  onPosted,
  onCancel,
}: {
  storeId: string;
  supplierId: string;
  userId: string | null;
  onPosted: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  type Kind = "payment" | "credit_note" | "opening_balance" | "adjustment";

  const [kind, setKind] = useState<Kind>("payment");
  const [amountInput, setAmountInput] = useState("");
  const [entryDate, setEntryDate] = useState(todayLocalDate());
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [adjustmentSign, setAdjustmentSign] = useState<"+" | "-">("-");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);

    let amountCents: number;

    try {
      amountCents = parseUsdInput(amountInput);
    } catch {
      setError(t("supplierDetail.errInvalidAmount"));
      return;
    }

    if (amountCents <= 0) {
      setError(t("supplierDetail.errAmountPositive"));
      return;
    }

    let signed: number;

    switch (kind) {
      case "payment":
        signed = -amountCents;
        break;

      case "credit_note":
        signed = -amountCents;
        break;

      case "opening_balance":
        signed = amountCents;
        break;

      case "adjustment":
        signed = adjustmentSign === "+" ? amountCents : -amountCents;

        if (!notes.trim()) {
          setError(t("supplierDetail.errAdjustmentReason"));
          return;
        }

        break;
    }

    setSubmitting(true);

    try {
      await supplierLedgerRepo.postEntry({
        storeId,
        supplierId,
        entryType: kind,
        amountCents: signed,
        entryDate,
        paymentReference: paymentReference.trim() || null,
        notes: notes.trim() || null,
        createdByUserId: userId,
        deviceId: null,
      });

      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const kindLabels: Record<Kind, string> = {
    payment: t("supplierDetail.kindPayment"),
    credit_note: t("supplierDetail.kindCreditNote"),
    opening_balance: t("supplierDetail.kindOpeningBalance"),
    adjustment: t("supplierDetail.kindAdjustment"),
  };

  return (
    <Card>
      <CardHeader
        title={t("supplierDetail.formTitle")}
        subtitle={t("supplierDetail.formSubtitle")}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("common.cancel")}
          </Button>
        }
      />

      <CardBody className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            {t("supplierDetail.entryTypeLabel")}
          </label>

          <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 shadow-sm">
            {(["payment", "credit_note", "opening_balance", "adjustment"] as const).map(
              (k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={clsx(
                    "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                    kind === k
                      ? "bg-brand text-brand-fg"
                      : "text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {kindLabels[k]}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              {t("supplierDetail.amountLabel")}
            </label>

            <div className="flex items-center gap-2">
              {kind === "adjustment" && (
                <div className="inline-flex rounded-md border border-slate-300 bg-white text-xs shadow-sm">
                  <button
                    type="button"
                    onClick={() => setAdjustmentSign("+")}
                    className={clsx(
                      "px-2 py-1.5",
                      adjustmentSign === "+"
                        ? "bg-red-600 text-white"
                        : "text-slate-600 hover:bg-slate-50",
                    )}
                    title={t("supplierDetail.increaseOwed")}
                  >
                    +
                  </button>

                  <button
                    type="button"
                    onClick={() => setAdjustmentSign("-")}
                    className={clsx(
                      "px-2 py-1.5",
                      adjustmentSign === "-"
                        ? "bg-emerald-600 text-white"
                        : "text-slate-600 hover:bg-slate-50",
                    )}
                    title={t("supplierDetail.decreaseOwed")}
                  >
                    −
                  </button>
                </div>
              )}

              <div className="flex flex-1 items-center rounded-md border border-slate-300 bg-white px-2 shadow-sm">
                <span className="text-xs text-slate-500">$</span>

                <input
                  type="text"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="0.00"
                  className="ms-1 flex-1 py-1.5 text-sm focus:outline-none"
                />
              </div>
            </div>
          </div>

          <Input
            type="date"
            label={t("supplierDetail.dateLabel")}
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />

          {(kind === "payment" || kind === "credit_note") && (
            <Input
              label={kind === "payment" ? t("supplierDetail.paymentRef") : t("supplierDetail.creditNoteRef")}
              placeholder={kind === "payment" ? t("supplierDetail.paymentRefPlaceholder") : t("supplierDetail.creditNoteRefPlaceholder")}
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
            />
          )}
        </div>

        <Input
          label={kind === "adjustment" ? t("supplierDetail.reasonLabel") : t("supplierDetail.notesLabel")}
          placeholder={kind === "adjustment" ? t("supplierDetail.reasonPlaceholder") : t("supplierDetail.optionalPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t("supplierDetail.posting") : t("supplierDetail.postEntry")}
          </Button>

          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
