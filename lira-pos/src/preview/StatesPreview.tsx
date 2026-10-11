/**
 * DESIGN PREVIEW — NOT PART OF THE APPLICATION.
 *
 * The status/warning/error surfaces, each rendered TWICE: once with the
 * literal Tailwind hues the page used before the accessibility correction,
 * and once with the semantic theme tokens it uses now. Both halves are on the
 * same page, in the same appearance, so the Midnight failure and its fix can
 * be read off one screenshot instead of two runs.
 *
 * `vite build` bundles `index.html` only, so nothing here ships — which is
 * also why keeping the superseded `before` classes in this file is safe. They
 * exist to be looked at, and they are the reason the correction is visible.
 *
 * The `before` strings are copied verbatim from the pre-correction source at
 * commit 879af5a; the `after` strings are copied verbatim from the files as
 * they now stand. Open at /preview.html?state=states&theme=midnight.
 */
import type { ReactNode } from "react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

/** One state, shown before and after. */
function Pair({
  title,
  where,
  before,
  after,
}: {
  title: string;
  where: string;
  before: ReactNode;
  after: ReactNode;
}) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3 shadow-panel">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs font-extrabold uppercase tracking-wider text-fg">
          {title}
        </span>
        <span className="font-mono text-[10px] text-fg-muted">{where}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div data-half="before">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            before — literal hues
          </div>
          {before}
        </div>
        <div data-half="after">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            after — semantic tokens
          </div>
          {after}
        </div>
      </div>
    </div>
  );
}

export default function StatesPreview() {
  return (
    <div className="space-y-3 pb-8">
      <h2 className="greaz-display text-2xl uppercase text-fg">
        Status surfaces — before / after
      </h2>
      <p className="text-sm text-fg-muted">
        Every pane on the left uses the literal Tailwind hue the page carried
        before the correction. Every pane on the right uses the semantic role.
        Switch appearance with the control above.
      </p>

      {/* 1 ── shift open: the defect Pilot 001 found, at 1.01:1 */}
      <Pair
        title="Shift open"
        where="ShiftSummary.tsx:420"
        before={
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-3">
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <div className="flex-1">
              <span className="text-sm font-semibold text-emerald-800">
                Shift open
              </span>
              <span className="ms-3 text-sm text-emerald-700">
                Opened at 2026-10-11 13:24
              </span>
            </div>
            <div className="flex gap-6 text-sm">
              <span className="text-slate-600">
                Opening USD{" "}
                <span className="font-medium text-slate-900">$206.00</span>
              </span>
              <span className="text-slate-600">
                Opening LBP{" "}
                <span className="font-medium text-slate-900">100,000 L.L.</span>
              </span>
            </div>
          </div>
        }
        after={
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-good-line bg-good-bg px-5 py-3">
            <div className="h-2.5 w-2.5 rounded-full bg-good" />
            <div className="flex-1">
              <span className="text-sm font-semibold text-good-fg">
                Shift open
              </span>
              <span className="ms-3 text-sm text-fg-muted">
                Opened at 2026-10-11 13:24
              </span>
            </div>
            <div className="flex gap-6 text-sm">
              <span className="text-fg-muted">
                Opening USD <span className="font-medium text-fg">$206.00</span>
              </span>
              <span className="text-fg-muted">
                Opening LBP{" "}
                <span className="font-medium text-fg">100,000 L.L.</span>
              </span>
            </div>
          </div>
        }
      />

      {/* 2 ── shift closed */}
      <Pair
        title="Shift closed / no open shift"
        where="ShiftSummary.tsx:374"
        before={
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            No open shift. Open a shift before ringing up a sale.
          </div>
        }
        after={
          <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
            No open shift. Open a shift before ringing up a sale.
          </div>
        }
      />

      {/* 3 ── successful operation */}
      <Pair
        title="Successful operation"
        where="Products.tsx:940"
        before={
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            Product saved.
          </div>
        }
        after={
          <div className="rounded-md border border-good-line bg-good-bg px-3 py-2 text-xs text-good-fg">
            Product saved.
          </div>
        }
      />

      {/* 4 ── warning */}
      <Pair
        title="Warning"
        where="ExchangeRate.tsx:309"
        before={
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-800">
              No rate for today. The register cannot take lira until one is set.
            </p>
          </div>
        }
        after={
          <div className="rounded-md border border-warn-line bg-warn-bg p-4">
            <p className="text-sm text-warn-fg">
              No rate for today. The register cannot take lira until one is set.
            </p>
          </div>
        }
      />

      {/* 5 ── validation error (real Input component, already tokenised) */}
      <Pair
        title="Validation error"
        where="ui/Input.tsx + SupplierPicker.tsx:163"
        before={
          <div className="space-y-2">
            <label className="block text-[11px] font-extrabold text-fg">
              Supplier name
            </label>
            <input
              defaultValue=""
              className="mt-1 block w-full rounded-md border border-red-400 px-2 py-1.5 text-sm shadow-sm"
            />
            <p className="mt-1 text-xs text-red-600">Name is required.</p>
          </div>
        }
        after={
          <Input label="Supplier name" error="Name is required." defaultValue="" />
        }
      />

      {/* 6 ── out of stock */}
      <Pair
        title="Out of stock"
        where="pos/MenuTile.tsx:86 · Inventory.tsx"
        before={
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-amber-800 ring-1 ring-inset ring-amber-200 bg-amber-100">
              out of stock
            </span>
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
              −3 pcs
            </span>
          </div>
        }
        after={
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-chip bg-warn-bg px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-warn-fg">
              out of stock
            </span>
            <span className="rounded bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger-fg">
              −3 pcs
            </span>
          </div>
        }
      />

      {/* 7 ── disabled action */}
      <Pair
        title="Disabled action"
        where="ui/Button.tsx (disabled:opacity-50)"
        before={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled>
              Post Sale
            </Button>
            <Button variant="secondary" disabled>
              Park
            </Button>
            <Button variant="danger" disabled>
              Void
            </Button>
          </div>
        }
        after={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled>
              Post Sale
            </Button>
            <Button variant="secondary" disabled>
              Park
            </Button>
            <Button variant="danger" disabled>
              Void
            </Button>
          </div>
        }
      />

      {/* 8 ── refund / return warning */}
      <Pair
        title="Refund / return warning"
        where="CreateReturnModal.tsx:341"
        before={
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This sale was settled by card. A cash refund is not available.
          </div>
        }
        after={
          <div className="rounded-md border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-fg">
            This sale was settled by card. A cash refund is not available.
          </div>
        }
      />

      {/* 9 ── purchase / inventory error */}
      <Pair
        title="Purchase / inventory error"
        where="Inventory.tsx · Purchases.tsx"
        before={
          <div className="space-y-2">
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              Adjustment refused: it would leave stock below zero (−2 pcs).
            </div>
            <table className="w-full text-sm">
              <tfoot className="bg-slate-50 text-sm">
                <tr>
                  <td className="px-3 py-2 text-right font-medium text-slate-700">
                    Total value
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-900">
                    $1,284.00
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
        after={
          <div className="space-y-2">
            <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
              Adjustment refused: it would leave stock below zero (−2 pcs).
            </div>
            <table className="w-full text-sm">
              <tfoot className="bg-slate-50 text-sm">
                <tr>
                  <td className="px-3 py-2 text-right font-medium text-slate-700">
                    Total value
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-good-fg">
                    $1,284.00
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
      />

      {/* 10 ── the shared Badge, all tones */}
      <Pair
        title="Badge tones"
        where="ui/Badge.tsx (info was the last literal tone)"
        before={
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral">neutral</Badge>
            <Badge tone="brand">brand</Badge>
            <Badge tone="good">posted</Badge>
            <Badge tone="warn">draft</Badge>
            <Badge tone="bad">voided</Badge>
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-200">
              info
            </span>
          </div>
        }
        after={
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral">neutral</Badge>
            <Badge tone="brand">brand</Badge>
            <Badge tone="good">posted</Badge>
            <Badge tone="warn">draft</Badge>
            <Badge tone="bad">voided</Badge>
            <Badge tone="info">info</Badge>
          </div>
        }
      />

      {/* 11 ── the +/- direction toggles: white on emerald-600 was 3.77:1 */}
      <Pair
        title="Direction toggle (selected)"
        where="Inventory.tsx:907 · SupplierDetail.tsx:387"
        before={
          <div className="inline-flex rounded-md border border-slate-300 bg-surface text-xs shadow-sm">
            <button type="button" className="bg-emerald-600 px-2 py-1 text-white">
              +
            </button>
            <button type="button" className="px-2 py-1 text-slate-600">
              −
            </button>
          </div>
        }
        after={
          <div className="inline-flex rounded-md border border-line bg-surface text-xs shadow-sm">
            <button
              type="button"
              className="bg-good-solid px-2 py-1 text-good-solid-fg"
            >
              +
            </button>
            <button type="button" className="px-2 py-1 text-fg-muted">
              −
            </button>
          </div>
        }
      />
    </div>
  );
}
