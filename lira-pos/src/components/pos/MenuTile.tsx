import clsx from "clsx";

/**
 * One menu item, as a big click target — the approved prototype's `.tile`.
 *
 * Geometry is lifted from the prototype rather than invented: 125px minimum,
 * the name reserving two lines so a long item cannot leave the grid ragged,
 * the price pinned to the bottom by `mt-auto`, and the `+` affordance in the
 * corner. Radius comes from a token because the two concepts disagree about
 * it — Classic's tiles are nearly square at 5px, Midnight's are 13px.
 *
 * An out-of-stock tile is SHOWN and disabled rather than hidden. The cashier
 * has to be able to tell the customer "no fries today", which a missing tile
 * does not say, and the price stays legible because "how much are the wings?"
 * is still asked on a day the wings ran out.
 *
 * ## Why the out-of-stock tile is no longer faded (WP-A6)
 *
 * It used to be the whole tile at `opacity-[0.38]`, which defeated the
 * paragraph above: at 38% the item name landed around 2:1 against the tile and
 * the price lower still, so the one thing the tile exists to tell the cashier —
 * WHICH item and HOW MUCH — became the hardest thing on the screen to read, in
 * both appearances and worse in Midnight.
 *
 * Transparency was doing two jobs at once: saying "not available" and saying
 * "de-emphasised". The signals are separated now. Unavailability is said
 * EXPLICITLY — a dashed border, a struck-through price and a full-contrast
 * SOLD-OUT chip — and emphasis is handled by the ordinary muted text roles,
 * which are contrast-checked tokens rather than a blanket alpha. Nothing about
 * the tile reads as orderable: it is still `disabled`, still
 * `cursor-not-allowed`, and now says so in words instead of in opacity. Only
 * the decorative corner glyph stays faded, because it carries no information.
 *
 * Purely presentational: it is handed a formatted price string and an onClick.
 * It knows nothing about products, stock, VAT or carts, which is what lets the
 * design preview render it against a fixture with no database in sight.
 */
export function MenuTile({
  name,
  price,
  meta,
  symbol,
  outOfStock,
  outOfStockLabel,
  onClick,
}: {
  name: string;
  price: string;
  /** Short qualifier under the name ("7 pcs"). Reserved; see `symbol`. */
  meta?: string;
  /** Decorative glyph in the corner. Reserved; see the note in PosRegister. */
  symbol?: string;
  outOfStock: boolean;
  outOfStockLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={outOfStock}
      title={outOfStock ? `${name} — ${outOfStockLabel}` : name}
      className={clsx(
        "group/tile relative flex min-h-[125px] flex-col items-stretch rounded-tile border-[1.5px] px-[11px] pb-2.5 pt-[13px] text-start transition-[transform,border-color,box-shadow] duration-100",
        "squat:min-h-[112px] squat:pt-2.5",
        outOfStock
          ? "cursor-not-allowed border-dashed border-line bg-paper"
          : // Red arrives on HOVER, not at rest. Twenty red tiles at rest would
            // be a messy poster and would destroy scanning speed; red on the
            // one tile under the cursor is brand personality that also says
            // what you are about to add.
            "border-line bg-tile shadow-tile hover:border-brand hover:shadow-tile-hover active:scale-[0.985]",
      )}
    >
      {symbol && (
        <span
          aria-hidden="true"
          className={clsx(
            "pointer-events-none absolute top-3 text-[27px] leading-none ltr:right-3 rtl:left-3",
            // The one thing that may still fade: it is decoration and carries
            // nothing the cashier needs to read.
            outOfStock && "opacity-40",
          )}
        >
          {symbol}
        </span>
      )}

      {/* The item name IS the poster voice — uppercase, condensed, two lines
          reserved. Not a number, so the display face is safe here. */}
      <span
        className={clsx(
          "greaz-display line-clamp-2 min-h-[52px] max-w-[calc(100%-42px)] text-[17px] uppercase leading-[1.15] squat:min-h-[44px] squat:text-[16px]",
          outOfStock ? "text-fg-muted" : "text-fg",
        )}
      >
        {name}
      </span>

      <span className="min-h-[14px] truncate text-[10px] leading-tight text-fg-muted" title={meta}>
        {meta ?? " "}
      </span>

      <span className="mt-auto flex items-end justify-between gap-2 pt-1">
        {/* Big, red, display-weight — the prototype's `.tile .price`. This is a
            headline figure on a poster, not a line item a cashier reads back,
            which is why it may wear the display face when the cart rows and
            the payment fields may not. */}
        <span
          className={clsx(
            "greaz-display text-[24px] leading-none squat:text-[22px]",
            // Struck through rather than dimmed: a line through a price says
            // "not today" in a way no amount of grey does, and it stays
            // legible while saying it.
            outOfStock ? "text-fg-muted line-through" : "text-brand-ink",
          )}
        >
          {price}
        </span>
        {outOfStock ? (
          <span className="shrink-0 rounded-chip bg-warn-bg px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-warn-fg">
            {outOfStockLabel}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full bg-brand text-sm font-extrabold leading-none text-brand-fg"
          >
            +
          </span>
        )}
      </span>
    </button>
  );
}
