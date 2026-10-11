import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * The menu pane — the prototype's `.mainpane`.
 *
 * A panel, not a back-office `Card`: the heading is the poster voice at 25px
 * and the search field sits inline with it, which is the shape the approved
 * screenshots show. Presentational, so the preview renders it too.
 */
export function MenuPane({
  title,
  subtitle,
  search,
  children,
  footnote,
}: {
  title: string;
  subtitle?: string;
  /** Right-aligned controls in the heading row (filter, scan toggle). */
  search?: ReactNode;
  children: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-panel border border-line bg-surface p-4 shadow-panel squat:p-3 tiny:p-2.5 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="greaz-display text-[25px] uppercase leading-none text-fg squat:text-[22px] tiny:text-[19px]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-[3px] text-[11px] text-fg-muted">{subtitle}</p>
          )}
        </div>
        {search && <div className="flex shrink-0 items-center gap-2">{search}</div>}
      </div>
      {/* The caller puts the chip row (fixed) and the tile grid (the part
          that scrolls) in here; this is the column they flex inside. */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {footnote && (
        <p className="mx-[1px] mt-3 shrink-0 text-[11px] text-fg-muted squat:mt-2">
          {footnote}
        </p>
      )}
    </section>
  );
}

/**
 * A menu group chip — the prototype's `.cats button`.
 *
 * Uppercase, heavy, square-ish on Classic and rounder on Midnight because the
 * radius is a token. Selected is a solid brand fill, which is the same
 * "one loud thing" rule the active nav pill follows.
 */
export function MenuChip({
  children,
  selected,
  count,
  onClick,
}: {
  children: ReactNode;
  selected: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border px-3.5 py-2.5 text-[11px] font-black uppercase transition-colors squat:py-2",
        selected
          ? "border-brand bg-brand text-brand-fg"
          : "border-line bg-paper text-fg hover:border-brand hover:text-brand-ink",
      )}
    >
      {children}
      {count !== undefined && (
        <span
          className={clsx(
            "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
            selected ? "bg-black/20 text-brand-fg" : "bg-surface text-fg-muted",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
