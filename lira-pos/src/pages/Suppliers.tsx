import { useCallback, useEffect, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { suppliersRepo } from "../db/repos/suppliers";
import type { Supplier } from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import clsx from "clsx";

export default function Suppliers() {
  const { storeId } = useActiveContext();
  const [rows, setRows] = useState<Supplier[]>([]);
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
    } finally {
      setLoading(false);
    }
  }, [storeId, search, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!storeId) return <div className="text-sm text-slate-500">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Suppliers</h2>
          <p className="text-sm text-slate-600">
            The vendors you buy from. Used when recording purchases.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {justSaved && (
            <span className="text-sm text-emerald-700">✓ Supplier added</span>
          )}
          <Button
            variant={formOpen ? "ghost" : "primary"}
            onClick={() => setFormOpen((o) => !o)}
          >
            {formOpen ? "Close form" : "New supplier"}
          </Button>
        </div>
      </div>

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
        <CardHeader title="Filter" />
        <CardBody className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <Input
              placeholder="Search by name, contact, phone, email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="rounded border-slate-300"
            />
            Include inactive
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Suppliers"
          subtitle={
            loading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "record" : "records"}`
          }
        />
        {rows.length === 0 && !loading ? (
          <CardBody>
            <div className="py-8 text-center text-sm text-slate-500">
              No suppliers match.
            </div>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-5 py-2 font-medium">Contact</th>
                  <th className="px-5 py-2 font-medium">Phone</th>
                  <th className="px-5 py-2 font-medium">Email</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    className={clsx(
                      "hover:bg-slate-50",
                      !s.isActive && "bg-slate-50/60 text-slate-500",
                    )}
                  >
                    <td className="px-5 py-2 font-medium text-slate-900">
                      {s.name}
                      {!s.isActive && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-slate-600">{s.contactName ?? "—"}</td>
                    <td className="px-5 py-2 text-slate-600">{s.phone ?? "—"}</td>
                    <td className="px-5 py-2 text-slate-600">{s.email ?? "—"}</td>
                    <td className="px-5 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void suppliersRepo.setActive(s.id, !s.isActive).then(reload);
                        }}
                      >
                        {s.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
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

function NewSupplierForm({
  storeId,
  onCreated,
  onCancel,
}: {
  storeId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Name is required.");
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
        title="New supplier"
        actions={
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <Input label="Name *" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input label="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving…" : "Save supplier"}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
