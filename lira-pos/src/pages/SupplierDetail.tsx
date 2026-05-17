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
import clsx from "clsx";

export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const { storeId, userId } = useActiveContext();

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
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  if (!supplier) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-slate-600">Supplier not found.</p>
        <Link to="/suppliers" className="text-sm text-brand underline">
          ← Back to suppliers
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/suppliers" className="text-xs text-brand hover:underline">
            ← All suppliers
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

        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Balance owed
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
            <div className="text-[10px] text-emerald-700">credit on file</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant={formOpen ? "ghost" : "primary"}
          onClick={() => setFormOpen((o) => !o)}
        >
          {formOpen ? "Close form" : "Record entry"}
        </Button>

        {justSaved && (
          <span className="text-sm text-emerald-700">✓ Entry posted</span>
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
          title="Ledger"
          subtitle="Append-only. Mistakes are fixed by posting a correcting entry."
        />

        {entries.length === 0 ? (
          <CardBody>
            <div className="py-8 text-center text-sm text-slate-500">
              No activity yet. Posting a purchase from this supplier — or a
              payment recorded here — will appear.
            </div>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Date</th>
                  <th className="px-5 py-2 font-medium">Type</th>
                  <th className="px-5 py-2 font-medium">Notes</th>
                  <th className="px-5 py-2 font-medium text-right">Amount</th>
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
                          payment: {e.relatedPaymentId}
                        </div>
                      )}
                    </td>

                    <td
                      className={clsx(
                        "px-5 py-2 text-right font-medium",
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
  const meta: Record<LedgerEntryType, { label: string; className: string }> = {
    purchase: {
      label: "purchase",
      className: "bg-slate-200 text-slate-700",
    },
    payment: {
      label: "payment",
      className: "bg-emerald-100 text-emerald-800",
    },
    credit_note: {
      label: "credit note",
      className: "bg-teal-100 text-teal-800",
    },
    opening_balance: {
      label: "opening balance",
      className: "bg-indigo-100 text-indigo-800",
    },
    adjustment: {
      label: "adjustment",
      className: "bg-amber-100 text-amber-800",
    },
  };

  const m = meta[type];

  return (
    <span className={clsx("rounded px-2 py-0.5 text-xs font-medium", m.className)}>
      {m.label}
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
      setError("Enter a valid amount.");
      return;
    }

    if (amountCents <= 0) {
      setError("Amount must be positive.");
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
          setError("Adjustment requires a reason in Notes.");
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

  return (
    <Card>
      <CardHeader
        title="Record entry"
        subtitle="Payments, credit notes, opening balances, manual adjustments."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        }
      />

      <CardBody className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Entry type
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
                  {k === "payment"
                    ? "Payment"
                    : k === "credit_note"
                      ? "Credit note"
                      : k === "opening_balance"
                        ? "Opening balance"
                        : "Adjustment"}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Amount *
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
                    title="Increase what we owe"
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
                    title="Decrease what we owe"
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
                  className="ml-1 flex-1 py-1.5 text-sm focus:outline-none"
                />
              </div>
            </div>
          </div>

          <Input
            type="date"
            label="Date *"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />

          {(kind === "payment" || kind === "credit_note") && (
            <Input
              label={kind === "payment" ? "Payment reference" : "Credit note ref"}
              placeholder={kind === "payment" ? "Wire / check / cash" : "CM-001"}
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
            />
          )}
        </div>

        <Input
          label={kind === "adjustment" ? "Reason *" : "Notes"}
          placeholder={kind === "adjustment" ? "Why is this adjustment needed?" : "Optional"}
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
            {submitting ? "Posting…" : "Post entry"}
          </Button>

          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}