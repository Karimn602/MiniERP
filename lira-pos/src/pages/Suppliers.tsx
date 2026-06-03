import { useCallback, useEffect, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { suppliersRepo } from "../db/repos/suppliers";
import { supplierLedgerRepo } from "../db/repos/supplierLedger";
import type { Supplier } from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { formatUsd } from "../lib/money";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

type SupplierBalanceSummary = {
  balanceCents: number;
  lastActivityAt: string | null;
};

export default function Suppliers() {
  const { storeId } = useActiveContext();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [rows, setRows] = useState<Supplier[]>([]);
  const [balances, setBalances] = useState<Map<string, SupplierBalanceSummary>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const reload = useCallback(async () => {
    if (!storeId) return;

    setLoading(true);

    try {
      const list = await suppliersRepo.list({
        storeId,
        search: search.trim() || undefined,
        includeInactive,
      });

      setRows(list);

      try {
        const bals = await supplierLedgerRepo.listBalances(storeId);
        setBalances(bals);
      } catch (balanceError) {
        console.error("Failed to load supplier balances:", balanceError);
        setBalances(new Map());
      }
    } catch (e) {
      console.error("Failed to load suppliers:", e);
      setRows([]);
      setBalances(new Map());
    } finally {
      setLoading(false);
    }
  }, [storeId, search, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!storeId) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const listSubtitle = loading
    ? t("common.loading")
    : t(rows.length === 1 ? "suppliers.countOne" : "suppliers.countMany", {
        count: String(rows.length),
      });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("suppliers.title")}
        subtitle={t("suppliers.subtitle")}
        actions={
          <div className="flex items-center gap-3">
            {justSaved && (
              <span className="text-sm font-medium text-emerald-600">{t("suppliers.supplierAdded")}</span>
            )}

            <Button
              variant={formOpen ? "ghost" : "primary"}
              onClick={() => setFormOpen((o) => !o)}
            >
              {formOpen ? t("suppliers.closeForm") : t("suppliers.newSupplier")}
            </Button>
          </div>
        }
      />

      {formOpen && (
        <NewSupplierForm
          storeId={storeId}
          onCreated={() => {
            setFormOpen(false);
            setJustSaved(true);
            setTimeout(() => setJustSaved(false), 2500);
            void reload();
          }}
          onCancel={() => setFormOpen(false)}
        />
      )}

      <Card>
        <CardHeader title={t("suppliers.filterTitle")} />

        <CardBody className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <Input
              placeholder={t("suppliers.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-slate-300 accent-brand"
            />
            {t("suppliers.includeInactive")}
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t("suppliers.listTitle")}
          subtitle={listSubtitle}
        />

        {rows.length === 0 && !loading ? (
          <EmptyState title={t("suppliers.noMatch")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">{t("suppliers.colName")}</th>
                  <th className="px-5 py-2 font-medium">{t("suppliers.colContact")}</th>
                  <th className="px-5 py-2 font-medium">{t("suppliers.colPhone")}</th>
                  <th className="px-5 py-2 font-medium text-end">{t("suppliers.colBalance")}</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {rows.map((s) => {
                  const bal = balances.get(s.id)?.balanceCents ?? 0;

                  return (
                    <tr
                      key={s.id}
                      className={clsx(
                        "cursor-pointer hover:bg-slate-50",
                        !s.isActive && "bg-slate-50/60 text-slate-500",
                      )}
                      onClick={() => navigate(`/suppliers/${s.id}`)}
                    >
                      <td className="px-5 py-2 font-medium text-slate-900">
                        {s.name}

                        {!s.isActive && (
                          <Badge tone="neutral" className="ms-2 uppercase">
                            {t("suppliers.inactive")}
                          </Badge>
                        )}
                      </td>

                      <td className="px-5 py-2 text-slate-600">
                        {s.contactName ?? "—"}
                      </td>

                      <td className="px-5 py-2 text-slate-600">
                        {s.phone ?? "—"}
                      </td>

                      <td
                        className={clsx(
                          "px-5 py-2 text-end font-medium",
                          bal > 0
                            ? "text-red-700"
                            : bal < 0
                              ? "text-emerald-700"
                              : "text-slate-500",
                        )}
                      >
                        {bal === 0 ? "—" : formatUsd(bal)}
                      </td>

                      <td className="px-5 py-2 text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void suppliersRepo.setActive(s.id, !s.isActive).then(reload);
                          }}
                        >
                          {s.isActive ? t("suppliers.deactivate") : t("suppliers.reactivate")}
                        </Button>
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

function NewSupplierForm({
  storeId,
  onCreated,
  onCancel,
}: {
  storeId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError(t("suppliers.errNameRequired"));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await suppliersRepo.create({
        storeId,
        name: name.trim(),
        contactName: contactName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      });

      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t("suppliers.formNewTitle")}
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

      <CardBody className="space-y-3">
        <Input
          label={t("suppliers.fieldName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input
            label={t("suppliers.fieldContactName")}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />

          <Input
            label={t("suppliers.fieldPhone")}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />

          <Input
            label={t("suppliers.fieldEmail")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <Input
          label={t("suppliers.fieldNotes")}
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
            {submitting ? t("suppliers.saving") : t("suppliers.saveSupplier")}
          </Button>

          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t("common.cancel")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
