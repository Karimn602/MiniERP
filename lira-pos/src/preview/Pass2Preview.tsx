/**
 * DESIGN PREVIEW — NOT PART OF THE APPLICATION.
 *
 * The surfaces the SECOND accessibility pass corrected, each rendered twice.
 * Pass 1 is in StatesPreview.tsx and is left exactly as it was so its evidence
 * stays reproducible; this is a separate gallery for a separate pass.
 *
 * How the "before" halves work, and why it matters:
 *
 * Pass 1's defects were literal Tailwind hues, so its gallery could show the
 * before state just by keeping the old class. Pass 2's defects are different in
 * kind — they were THEMED tokens whose VALUES were too light, or a themed token
 * used where its contrast did not hold. The old class and the new class are
 * often the same string, so a class copy would show no difference at all.
 *
 * So each "before" pane reverts the TOKEN instead, inside a scoped class, and
 * then renders the real production component with its real production classes.
 * The CSS below pins each reverted variable for both appearances, which means
 * the before half is the exact colour that shipped in each theme rather than a
 * hardcoded hex that would only be right in one of them. It also means no
 * superseded or forbidden utility appears anywhere in this file, so the
 * contrast scanners in themeContrast.test.ts stay strict with no exemption for
 * the preview directory.
 *
 * `vite build` bundles `index.html` only, so none of this ships.
 * Open at /preview.html?state=states2&theme=midnight.
 */
import type { ReactNode } from "react";
import { MenuTile } from "../components/pos/MenuTile";
import { TotalBlock } from "../components/pos/OrderRail";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";

/**
 * The pre-correction token values, scoped per concern so a pane reverts only
 * what it is demonstrating. Each selector is written twice, once per
 * appearance, because every one of these defects had a different value in
 * Classic and Midnight — and four of the eight failed in Classic too, which is
 * the part a Midnight-only reading of the review would miss.
 */
const BEFORE_TOKENS = `
/* --greaz-brand-ink did not exist; brand letterforms used the FILL. */
.b-ink { --greaz-brand-ink: 209 27 50; }
:root[data-theme="midnight"] .b-ink { --greaz-brand-ink: 229 27 60; }

/* The faintest text tier: #968C8A / #8C7C7C. */
.b-subtle { --greaz-fg-subtle: 150 140 138; }
:root[data-theme="midnight"] .b-subtle { --greaz-fg-subtle: 140 124 124; }

/* Captions and muted financial values were text-slate-400, so the before
   half reverts fg-muted to slate-400's value in each appearance. */
.b-caption { --greaz-fg-muted: 148 163 184; }
:root[data-theme="midnight"] .b-caption { --greaz-fg-muted: 141 126 125; }

/* The hero band's kicker and subtitle. */
.b-banner { --greaz-banner-kicker: 209 27 50; --greaz-banner-sub: 111 103 102; }
:root[data-theme="midnight"] .b-banner {
  --greaz-banner-kicker: 246 179 186;
  --greaz-banner-sub: 222 205 202;
}
`;

/** One surface, shown before and after. */
function Pair({
  title,
  where,
  ratios,
  beforeClass,
  children,
  before,
  after,
}: {
  title: string;
  where: string;
  /** Measured Classic / Midnight, before -> after. */
  ratios: string;
  /** The scoped token-revert class the before half opts into. */
  beforeClass?: string;
  /** Rendered identically in both halves; the token differs. */
  children?: ReactNode;
  /** Used instead of `children` when the before state is structural. */
  before?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3 shadow-panel">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-xs font-extrabold uppercase tracking-wider text-fg">
          {title}
        </span>
        <span className="font-mono text-[10px] text-fg-muted">{where}</span>
      </div>
      <div className="mb-2 font-mono text-[10px] text-fg-muted">{ratios}</div>
      <div className="grid grid-cols-2 items-start gap-3">
        <div data-half="before" className={beforeClass}>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            before
          </div>
          {before ?? children}
        </div>
        <div data-half="after">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            after
          </div>
          {after ?? children}
        </div>
      </div>
    </div>
  );
}

export default function Pass2Preview() {
  return (
    <div className="space-y-3 pb-8">
      <style>{BEFORE_TOKENS}</style>

      <h2 className="greaz-display text-2xl uppercase text-fg">
        Pass 2 — active text contrast
      </h2>
      <p className="text-sm text-fg-muted">
        Each left pane reverts the token to the value that shipped, in whichever
        appearance is active, and then renders the same production component the
        right pane does. Switch appearance with the control above.
      </p>

      {/* 1 — the menu price: 22px/400 Impact in the squat layout, so NOT large
          text. This is the one the review called out explicitly. */}
      <Pair
        title="Menu tile price"
        where="pos/MenuTile.tsx:82 · brand fill -> brand ink"
        ratios="Midnight 3.52:1 -> 6.63:1 · Classic 5.14:1 unchanged (same red)"
        beforeClass="b-ink"
      >
        <div className="grid grid-cols-2 gap-2">
          <MenuTile
            name="Shawarma Plate"
            price="$12.50"
            meta="7 pcs"
            outOfStock={false}
            outOfStockLabel="out of stock"
            onClick={() => undefined}
          />
          <MenuTile
            name="Lentil Soup"
            price="$4.00"
            meta="out"
            outOfStock
            outOfStockLabel="out of stock"
            onClick={() => undefined}
          />
        </div>
      </Pair>

      {/* 2 — the checkout total and its lira equivalent. Structural: the before
          half is the `opacity-90` wrapper the row used to carry. */}
      <Pair
        title="Checkout amount due + LBP equivalent"
        where="pos/OrderRail.tsx:228 · dropped opacity-90"
        ratios="Midnight 3.94:1 -> 4.61:1 · Classic 4.56:1 -> 5.37:1"
        before={
          <div className="[&_.mt-1]:opacity-90">
            <TotalBlock
              label="Amount due"
              value="$47.25"
              secondaryLabel="LBP equivalent"
              secondaryValue="4,252,500 L.L."
            />
          </div>
        }
        after={
          <TotalBlock
            label="Amount due"
            value="$47.25"
            secondaryLabel="LBP equivalent"
            secondaryValue="4,252,500 L.L."
          />
        }
      />

      {/* 3 — the hero band. Solid red on Midnight, so everything on it is
          light-on-red and the band sets the ceiling. */}
      <Pair
        title="Hero kicker + subtitle"
        where="ui/PageHeader.tsx:53,61 · banner-kicker / banner-sub"
        ratios="Midnight 3.69:1 -> 5.03:1 and 4.19:1 -> 5.09:1 · Classic unchanged"
        beforeClass="b-banner"
      >
        <PageHeader
          variant="hero"
          eyebrow="Greaz · Counter"
          title="Register"
          subtitle="Shift open since 13:24 · rate locked at 90,000"
        />
      </Pair>

      {/* 4 — the F5 cap on the one button that posts money. Structural: a
          white wash LIGHTENED the pill under a white glyph. */}
      <Pair
        title="Post-sale button F5 key cap"
        where="pages/PosRegister.tsx:1817 · bg-white/15 -> bg-black/20"
        ratios="Midnight 3.98:1 -> 6.62:1 · Classic 4.46:1 -> 7.53:1"
        before={
          <button
            type="button"
            className="greaz-display w-full rounded-chip bg-brand px-4 py-3.5 text-[15px] uppercase tracking-wide text-brand-fg"
          >
            Post sale
            <kbd className="ms-2 rounded border border-white/30 bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
              F5
            </kbd>
          </button>
        }
        after={
          <button
            type="button"
            className="greaz-display w-full rounded-chip bg-brand px-4 py-3.5 text-[15px] uppercase tracking-wide text-brand-fg"
          >
            Post sale
            <kbd className="ms-2 rounded border border-white/30 bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
              F5
            </kbd>
          </button>
        }
      />

      {/* 5 — the workspace label, the faintest tier, on a plain card. */}
      <Pair
        title="Workspace label (fg-subtle)"
        where="components/AppShell.tsx:144 · --greaz-fg-subtle"
        ratios="Classic 3.27:1 -> 4.97:1 · Midnight 3.98:1 -> 5.50:1"
        beforeClass="b-subtle"
      >
        <h1 className="font-eyebrow truncate text-[10px] text-fg-subtle">
          Greaz POS — Counter · Training
        </h1>
      </Pair>

      {/* 6 — muted financial values and the captions under them, including the
          VAT-reversed hint. Both failed in CLASSIC, at 2.56:1. */}
      <Pair
        title="Financial values, captions and hints"
        where="ShiftSummary.tsx:55,61 · Inventory.tsx:246 · slate-400 -> fg-muted"
        ratios="Classic 2.56:1 -> 5.51:1 · Midnight 4.08:1 -> 6.71:1"
        beforeClass="b-caption"
      >
        <div className="space-y-2">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Output VAT
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-fg-muted">
              $18.40
            </div>
            <div className="mt-0.5 text-xs text-fg-muted">
              VAT reversed by credit memos is shown separately
            </div>
          </div>
          <StatCard label="VAT reversed" value="$3.15" hint="excl. VAT" />
        </div>
      </Pair>

      {/* 7 — the StatCard hint and its brand-tone value, together: the hint is
          the faintest tier and the value is a brand letterform. */}
      <Pair
        title="StatCard hint + brand-tone value"
        where="ui/StatCard.tsx:48,54 · fg-subtle and brand fill -> brand ink"
        ratios="hint Classic 3.27:1 -> 4.97:1 · value Midnight 3.44:1 -> 6.45:1"
        beforeClass="b-subtle b-ink"
      >
        <StatCard
          label="Net sales"
          value="$1,284.00"
          tone="brand"
          hint="after returns"
        />
      </Pair>
    </div>
  );
}
