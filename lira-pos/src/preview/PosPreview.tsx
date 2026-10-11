/**
 * DESIGN PREVIEW — NOT PART OF THE APPLICATION.
 *
 * A populated rendering of the POS Register's appearance, used to judge both
 * approved themes against the reference screenshots at 1366x768 without a
 * till, a shift or a database.
 *
 * ISOLATION, three ways over:
 *   1. It imports no repo, no `db/client`, no `tauri.invoke` and no posting
 *      command. Nothing here can read or write SQLite even in principle.
 *   2. It is served from `preview.html`, a separate Vite entry. `vite build`
 *      bundles `index.html` only, so none of this reaches a shipped build.
 *   3. It runs in a plain browser, outside the Tauri shell. The sandbox
 *      database lives in the app's own %APPDATA% folder and is reachable only
 *      through Tauri IPC, which does not exist here.
 *
 * The 17 items are `greaz_menu_design_fixture.json`, transcribed verbatim —
 * same codes, names, prices, categories, emoji and notes. They are NOT an
 * importer payload and create no product, no UoM and no catalog row. Real
 * menu setup is a separate job with the owner.
 *
 * TWO THINGS HERE DO NOT EXIST IN THE REAL REGISTER, and are preview-only on
 * purpose, so the approved design can be judged on a full menu:
 *   - CATEGORY CHIPS (Burgers / Wraps / Sides / Add-ons / Drinks). `products`
 *     has no category column, so the register derives "All" + "Out of stock"
 *     from live stock instead. Real sections are a migration, out of scope.
 *   - TILE EMOJI and the qualifier line. No emoji or short-description column
 *     exists either; the register renders those slots empty.
 * Everything else — every component, every token, every measurement — is
 * literally the same code the register runs.
 *
 * Query parameters: ?theme=classic|midnight, ?lang=en|ar, and
 * ?state=order (default: a non-empty cart with a discount and cash taken) or
 * ?state=menu (empty cart, so the empty-order affordance can be seen).
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { MenuTile } from "../components/pos/MenuTile";
import { MenuPane, MenuChip } from "../components/pos/MenuPane";
import {
  AmountLine,
  CartLineRow,
  RailHeading,
  ShiftChip,
  TinyButton,
  TotalBlock,
} from "../components/pos/OrderRail";

interface FixtureItem {
  code: string;
  category: string;
  name: string;
  price: number;
  emoji: string;
  note?: string;
}

/** design-references/greaz-theme-references/greaz_menu_design_fixture.json */
const ITEMS: FixtureItem[] = [
  { code: "GZ-BUR-DOUBLE", category: "Burgers", name: "Double Burger", price: 6.0, emoji: "🍔", note: "2 patties" },
  { code: "GZ-BUR-TRIPLE", category: "Burgers", name: "Triple Burger", price: 8.0, emoji: "🍔", note: "3 patties" },
  { code: "GZ-BUR-CHICKEN", category: "Burgers", name: "Chicken Burger", price: 6.0, emoji: "🍔", note: "BBQ or buffalo sauce" },
  { code: "GZ-WRP-BONELESS", category: "Wraps", name: "Boneless Wrap", price: 6.0, emoji: "🌯", note: "As shown on printed menu" },
  { code: "GZ-SID-FRIES", category: "Sides", name: "Fries", price: 3.0, emoji: "🍟" },
  { code: "GZ-SID-CHILI", category: "Sides", name: "Chili Fries", price: 5.0, emoji: "🍟" },
  { code: "GZ-SID-LOADED", category: "Sides", name: "Loaded Fries", price: 5.0, emoji: "🍟" },
  { code: "GZ-SID-ONION", category: "Sides", name: "Onion Rings (7 pcs)", price: 5.0, emoji: "🧅" },
  { code: "GZ-SID-CHEESE", category: "Sides", name: "Cheese Balls (6 pcs)", price: 5.0, emoji: "🧀" },
  { code: "GZ-SID-WINGS", category: "Sides", name: "Wings (7 pcs)", price: 5.0, emoji: "🍗", note: "BBQ / honey mustard / buffalo" },
  { code: "GZ-SID-TENDERS", category: "Sides", name: "Chicken Tenders (4 pcs)", price: 5.0, emoji: "🍗", note: "BBQ / honey mustard / buffalo" },
  { code: "GZ-ADD-BACON", category: "Add-ons", name: "Beef Bacon", price: 2.0, emoji: "🥓" },
  { code: "GZ-ADD-MOZZ", category: "Add-ons", name: "Mozzarella Patty", price: 2.0, emoji: "🧀" },
  { code: "GZ-ADD-ONION", category: "Add-ons", name: "Onion Rings Add-on", price: 2.0, emoji: "🧅" },
  { code: "GZ-ADD-CHEDDAR", category: "Add-ons", name: "Red Cheddar Slice", price: 1.0, emoji: "🧀" },
  { code: "GZ-DRK-SOFT", category: "Drinks", name: "Soft Drink", price: 1.0, emoji: "🥤" },
  { code: "GZ-DRK-WATER", category: "Drinks", name: "Water", price: 0.5, emoji: "💧" },
];

/** Preview-only. The register derives its chips from live stock instead. */
const CATEGORIES = ["All", "Burgers", "Wraps", "Sides", "Add-ons", "Drinks"];

const RATE = 89_500;
const VAT_BPS = 1100;
const usd = (n: number) => `$${n.toFixed(2)}`;
const lbp = (n: number) => `${Math.round(n).toLocaleString("en-US")} L.L.`;

/** An order a Greaz cashier could plausibly be holding: five lines, mixed
 *  quantities, spanning burgers, sides, add-ons and drinks. Five lines also
 *  exercises the cart's scroll at 1366x768, where two are visible at once. */
const SAMPLE_ORDER: Record<string, number> = {
  "GZ-BUR-DOUBLE": 2,
  "GZ-SID-CHILI": 1,
  "GZ-SID-WINGS": 2,
  "GZ-ADD-BACON": 1,
  "GZ-DRK-SOFT": 3,
};

export default function PosPreview() {
  const qs = new URLSearchParams(location.search);
  const ordered = qs.get("state") !== "menu";
  // ?discount=off shows the same order without an expanded discount panel,
  // which is the difference between Post Sale fitting at 1366x768 and not.
  const withDiscount = ordered && qs.get("discount") !== "off";

  const [cart, setCart] = useState<Record<string, number>>(
    ordered ? SAMPLE_ORDER : {},
  );
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("All");
  const [discountOpen, setDiscountOpen] = useState(withDiscount);
  const [discountPct, setDiscountPct] = useState(withDiscount ? "10" : "");
  const [cashUsd, setCashUsd] = useState(ordered ? "20" : "");
  const [cashLbp, setCashLbp] = useState(ordered ? "800000" : "");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return ITEMS.filter((i) => {
      if (category !== "All" && i.category !== category) return false;
      if (q && !i.name.toLowerCase().includes(q) && !i.code.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [filter, category]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { All: ITEMS.length };
    for (const i of ITEMS) m[i.category] = (m[i.category] ?? 0) + 1;
    return m;
  }, []);

  const lines = ITEMS.filter((i) => (cart[i.code] ?? 0) > 0);
  const gross = lines.reduce((s, i) => s + i.price * cart[i.code], 0);
  const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const discount = (gross * pct) / 100;
  const total = gross - discount;
  const subtotal = total / (1 + VAT_BPS / 10_000);
  const vat = total - subtotal;
  const paid = (Number(cashUsd) || 0) + (Number(cashLbp) || 0) / RATE;
  const remaining = Math.max(0, total - paid);
  const change = Math.max(0, paid - total);

  // ?focus=discount|post moves the caret to a control so that keyboard
  // reachability — and scroll-into-view for a control inside the order card's
  // scroll region — can be checked in a screenshot.
  useEffect(() => {
    const want = new URLSearchParams(location.search).get("focus");
    if (!want) return;
    const sel =
      want === "post"
        ? 'button[type="button"].greaz-display'
        : 'input[inputmode="decimal"]';
    const el = document.querySelectorAll<HTMLElement>(sel);
    el[want === "post" ? el.length - 1 : 1]?.focus();
  }, []);

  const bump = (code: string, by: number) =>
    setCart((prev) => {
      const next = { ...prev };
      const q = (next[code] ?? 0) + by;
      if (q <= 0) delete next[code];
      else next[code] = q;
      return next;
    });

  return (
    <div className="flex flex-col gap-3.5 squat:gap-2 tiny:gap-1.5 lg:min-h-0 lg:flex-1">
      <PageHeader
        variant="hero"
        eyebrow="Not your usual burger"
        title="The Greaz Counter"
        subtitle="Tap a burger. Build the order. Take the cash."
        actions={
          <>
            <ShiftChip
              tone="good"
              title="Shift open"
              detail={`${RATE.toLocaleString("en-US")} L.L. / USD · Last purchase`}
            />
            <TinyButton onClick={() => undefined}>POS settings</TinyButton>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_325px]">
        <MenuPane
          title="The menu"
          subtitle="Tap once to add · tap again to add another"
          search={
            <>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 flex items-center text-fg-subtle ltr:left-3 rtl:right-3">
                  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                    <path d="m21 21-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find an item"
                  aria-label="Find an item"
                  className="w-[168px] rounded-chip border border-line bg-paper py-2.5 text-[11px] text-fg placeholder-fg-subtle transition-colors hover:border-fg-subtle focus:border-brand focus:outline-none ltr:pl-8 ltr:pr-3 rtl:pr-8 rtl:pl-3"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={() => undefined}>
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Scan
              </Button>
            </>
          }
          footnote="Design preview · fixture data, no database"
        >
          <div className="mt-[15px] flex shrink-0 flex-wrap items-center gap-[7px] squat:mt-2.5 squat:flex-nowrap squat:overflow-x-auto squat:pb-1">
            {CATEGORIES.map((c) => (
              <MenuChip
                key={c}
                selected={c === category}
                count={counts[c] ?? 0}
                onClick={() => setCategory(c)}
              >
                {c}
              </MenuChip>
            ))}
          </div>

          <div className="-mx-1 mt-3.5 max-h-[32rem] min-h-0 overflow-y-auto px-1 py-0.5 squat:mt-2.5 lg:max-h-none lg:flex-1">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
              {visible.map((i) => (
                <MenuTile
                  key={i.code}
                  name={i.name}
                  price={usd(i.price)}
                  meta={i.note}
                  symbol={i.emoji}
                  outOfStock={false}
                  outOfStockLabel="Out of stock"
                  onClick={() => bump(i.code, 1)}
                />
              ))}
            </div>
          </div>
        </MenuPane>

        {/* ─── RIGHT: the order rail ─────────────────────────────────────
            Bounded to the height actually available, and split in two: a
            SCROLLING upper region (tabs, order lines, discount, totals, amount
            due) and a PINNED cash panel. The payment card is the rail's own
            footer rather than content inside the scroller, so Post Sale and
            the cash fields are always on screen without covering anything —
            they are outside the scrolled box, not floating over it.

            This replaces a stack of per-element size trims that still left
            Post Sale ~35px below the fold at 1366x768 once a discount was
            expanded, and further at 125% scaling. Nothing is hidden to make
            it fit now: the lira remaining/change lines, the conversion hint
            and the discount labels are all back. */}
          <div className="flex min-w-0 flex-col gap-3 squat:gap-2 lg:h-full lg:min-h-0 lg:overflow-y-auto">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <div className="inline-flex items-center rounded-chip border border-brand bg-brand-soft">
              <button type="button" className="px-2.5 py-1.5 text-[11px] font-extrabold text-brand-700">
                Order 1
                {lines.length > 0 && <span className="tabular-nums"> ({lines.length})</span>}
              </button>
            </div>
            <div className="inline-flex items-center rounded-chip border border-line bg-surface">
              <button type="button" className="px-2.5 py-1.5 text-[11px] font-extrabold text-fg-muted">
                Order 2
              </button>
              <button type="button" aria-label="Close order" className="px-1.5 py-1.5 text-fg-subtle">
                ×
              </button>
            </div>
            <button
              type="button"
              className="rounded-chip border border-dashed border-line px-2.5 py-1.5 text-[11px] font-extrabold text-fg-muted transition-colors hover:border-brand hover:text-brand-ink"
            >
              + New order
            </button>
          </div>

          <section className="flex flex-col overflow-hidden rounded-panel border border-line bg-surface p-[15px] shadow-panel squat:p-2.5 tiny:p-2 lg:min-h-[6.75rem] lg:flex-1">
            <RailHeading
              actions={
                <>
                  {!discountOpen && (
                    <TinyButton onClick={() => setDiscountOpen(true)}>+ Discount</TinyButton>
                  )}
                  {lines.length > 0 && (
                    <TinyButton onClick={() => setCart({})}>Clear order</TinyButton>
                  )}
                </>
              }
            >
              Order 1
            </RailHeading>

            <div className="-mx-1 mt-3 min-h-[2.75rem] flex-1 scroll-p-2 overflow-y-auto tiny:min-h-0 px-1 squat:mt-1.5">
              {lines.length === 0 ? (
                <div className="rounded-chip border border-dashed border-line bg-paper px-2.5 py-8 text-center text-xs text-fg-muted squat:py-4">
                  Tap an item to start the order
                </div>
              ) : (
                <div>
                  {lines.map((i) => (
                    <CartLineRow
                      key={i.code}
                      name={i.name}
                      detail={`${usd(i.price)} · each · Stock 24`}
                      amount={usd(i.price * cart[i.code])}
                      quantity={cart[i.code]}
                      onDecrease={() => bump(i.code, -1)}
                      onIncrease={() => bump(i.code, 1)}
                      onRemove={() => bump(i.code, -cart[i.code])}
                      decreaseLabel="Decrease quantity"
                      increaseLabel="Increase quantity"
                      removeLabel="Remove"
                    />
                  ))}
                </div>
              )}

              {discountOpen && (
                <div className="mt-3 squat:mt-2">
                <div className="rounded-chip border border-line bg-paper p-2.5 squat:p-2">
                  <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                    <div className="min-w-0">
                      <Input
                        label="Discount %"
                        inputMode="decimal"
                        placeholder="0"
                        suffix="%"
                        value={discountPct}
                        onChange={(e) => setDiscountPct(e.target.value)}
                      />
                    </div>
                    <div className="min-w-0">
                      <Input
                        label="Discount $"
                        inputMode="decimal"
                        placeholder="0.00"
                        prefix="$"
                        value={discount > 0 ? discount.toFixed(2) : ""}
                        onChange={() => undefined}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => { setDiscountPct(""); setDiscountOpen(false); }}
                      className="h-[34px] shrink-0 rounded-chip border border-line px-2.5 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
                    >
                      Clear
                    </button>
                  </div>
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-1 border-t border-line pt-2.5 squat:mt-2 squat:pt-2">
                <AmountLine label="Subtotal (excl. VAT)" value={usd(subtotal)} />
                {discount > 0 && (
                  <AmountLine label={`Discount (${pct}%)`} value={`-${usd(discount)}`} tone="warn" />
                )}
                <AmountLine label="VAT" value={usd(vat)} />
              </div>
            </div>

            <TotalBlock
              label="Amount due"
              value={usd(total)}
              secondaryLabel="LBP equivalent"
              secondaryValue={lbp(total * RATE)}
            />
          </section>

          {/* The rail's pinned footer — a sibling of the order card, not
              content inside it. */}
          <section className="shrink-0 rounded-panel border border-line bg-surface p-[15px] shadow-panel squat:p-2.5">
            <h3 className="greaz-display text-[19px] uppercase leading-none text-fg squat:text-[18px] tiny:sr-only">
              Take cash
            </h3>
            <div className="mt-3 space-y-2.5 squat:mt-1.5 squat:space-y-1.5 tiny:grid tiny:grid-cols-2 tiny:gap-2 tiny:space-y-0">
              <Input
                label="Cash USD received"
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cashUsd}
                onChange={(e) => setCashUsd(e.target.value)}
              />
              <Input
                label={
                  Number(cashLbp) > 0
                    ? `Cash LBP received · ≈ ${usd(Number(cashLbp) / RATE)}`
                    : "Cash LBP received"
                }
                inputMode="numeric"
                placeholder="0"
                suffix="L.L."
                value={cashLbp}
                onChange={(e) => setCashLbp(e.target.value)}
              />
            </div>

            <div className="mt-3 space-y-1 rounded-chip border border-line bg-paper p-2.5 squat:mt-1.5 squat:p-2">
              <AmountLine label="Total paid (USD equiv.)" value={usd(paid)} />
              {remaining > 0 ? (
                <AmountLine
                  label="Remaining"
                  tone="warn"
                  value={
                    <>
                      {usd(remaining)}
                      <span className="ms-1.5 font-normal">· {lbp(remaining * RATE)}</span>
                    </>
                  }
                />
              ) : (
                <AmountLine
                  label="Change due"
                  tone="good"
                  strong
                  value={
                    <>
                      {usd(change)}
                      <span className="ms-1.5 font-normal">· {lbp(change * RATE)}</span>
                    </>
                  }
                />
              )}
            </div>

            <button
              type="button"
              disabled={remaining > 0 || lines.length === 0}
              className="greaz-display mt-3 w-full rounded-chip bg-brand px-4 py-3.5 text-[15px] uppercase tracking-wide text-brand-fg transition-all hover:bg-brand-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 squat:mt-2 squat:py-2.5"
            >
              Post sale
              <kbd className="ms-2 rounded border border-white/30 bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
                F5
              </kbd>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
