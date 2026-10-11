import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * The right-hand order rail — the prototype's `.order` / `.payment` column.
 *
 * All presentational. Every piece here takes formatted strings and callbacks,
 * so the design preview can render a populated rail against a fixture without
 * a database, a repo or a posting command anywhere near it.
 *
 * The rail is 325px wide, which is the constraint that shaped these parts: the
 * cart is a three-column row (name / stepper / amount), not the six-column
 * table it replaced. Nothing was dropped to get there — the UoM and the unit
 * price moved onto a muted sub-line under the item name, so the cashier can
 * still read everything the table showed.
 */

/** Section heading in the rail. Display face, uppercase, per the prototype. */
export function RailHeading({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h3 className="greaz-display text-[22px] uppercase leading-none text-fg squat:text-[19px] tiny:text-[17px]">
        {children}
      </h3>
      {actions}
    </div>
  );
}

/** Small secondary control in the rail ("Clear order"). */
export function TinyButton({
  children,
  onClick,
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "shrink-0 rounded-chip border border-line bg-paper px-2.5 py-1.5 text-[11px] font-extrabold text-fg transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * One cart line.
 *
 * Grid is the prototype's `minmax(0,1fr) 91px 57px` with a dashed rule under
 * each row. Amount and quantity are tabular lining numerals in the body face,
 * never the display face: these are the figures a cashier reads back to a
 * customer, and Impact has no Arabic glyphs.
 */
export function CartLineRow({
  name,
  detail,
  amount,
  quantity,
  onDecrease,
  onIncrease,
  onRemove,
  decreaseLabel,
  increaseLabel,
  removeLabel,
}: {
  name: string;
  detail?: ReactNode;
  amount: string;
  quantity: number;
  onDecrease: () => void;
  onIncrease: () => void;
  onRemove: () => void;
  decreaseLabel: string;
  increaseLabel: string;
  removeLabel: string;
}) {
  return (
    <div className="group/row grid grid-cols-[minmax(0,1fr)_91px_57px] items-center gap-1.5 border-b border-dashed border-line py-2.5 squat:py-1.5">
      <div className="min-w-0">
        <div className="truncate text-[11px] font-extrabold text-fg" title={name}>
          {name}
        </div>
        {detail && (
          <div className="truncate text-[10px] leading-tight text-fg-muted">
            {detail}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-1.5">
        <button
          type="button"
          onClick={onDecrease}
          aria-label={decreaseLabel}
          className="flex h-[25px] w-6 items-center justify-center rounded-chip border border-line bg-paper text-fg transition-colors hover:border-brand hover:text-brand-ink"
        >
          −
        </button>
        <span className="min-w-[14px] text-center text-[11px] font-extrabold tabular-nums text-fg">
          {quantity}
        </span>
        <button
          type="button"
          onClick={onIncrease}
          aria-label={increaseLabel}
          className="flex h-[25px] w-6 items-center justify-center rounded-chip border border-line bg-paper text-fg transition-colors hover:border-brand hover:text-brand-ink"
        >
          +
        </button>
      </div>

      <div className="flex items-center justify-end gap-1">
        <span className="text-[12px] font-black tabular-nums text-fg">{amount}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** A label/value line in the totals or payment-calc block. */
export function AmountLine({
  label,
  value,
  tone,
  strong,
  muted,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "good" | "warn" | "danger";
  strong?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-2 text-[12px] tiny:text-[11px]",
        className,
      )}
    >
      <span
        className={clsx(
          "min-w-0 truncate",
          muted ? "text-fg-subtle" : "text-fg-muted",
          tone === "warn" && "text-warn-fg",
          tone === "good" && "text-good-fg",
          tone === "danger" && "text-danger-fg",
        )}
      >
        {label}
      </span>
      <span
        className={clsx(
          "shrink-0 tabular-nums",
          strong ? "text-sm font-bold text-fg" : "font-semibold text-fg",
          muted && !strong && "font-normal text-fg-muted",
          tone === "warn" && "text-warn-fg",
          tone === "good" && "text-good-fg",
          tone === "danger" && "text-danger-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The amount due — the prototype's `.totalblock`.
 *
 * A solid brand-red field with the figure in the display face at 29px. This is
 * the single loudest number on the screen and the only place in the rail the
 * poster voice is allowed on a figure: it is a headline, read across a
 * counter, not a line item.
 */
export function TotalBlock({
  label,
  value,
  secondaryLabel,
  secondaryValue,
}: {
  label: string;
  value: string;
  secondaryLabel?: string;
  secondaryValue?: string;
}) {
  return (
    <div className="mt-3 shrink-0 rounded-chip bg-brand px-[15px] py-[15px] text-brand-fg squat:mt-1.5 squat:py-2.5 tiny:py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-black uppercase tracking-wide">
          {label}
        </span>
        <span className="greaz-display text-[29px] leading-none squat:text-[24px] tiny:text-[21px]">
          {value}
        </span>
      </div>
      {secondaryLabel && secondaryValue && (
        // No `opacity-90` here. This row is the lira equivalent of the amount
        // due — an active financial figure a cashier reads out — and fading
        // white to 90% over the brand red took it from 5.37:1 to 4.56:1 on
        // Classic and from 4.61:1 to 3.94:1 on Midnight, i.e. under AA at
        // 11px. Full `brand-fg` is the same colour the panel already uses for
        // its label, so the row still reads as secondary through size and
        // weight rather than through transparency.
        <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
          <span>{secondaryLabel}</span>
          <span className="tabular-nums">{secondaryValue}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The status chip riding in the hero band — "shift open" and the locked rate.
 * Mirrors the prototype's `.onshift`, including the green status dot.
 */
export function ShiftChip({
  title,
  detail,
  tone = "neutral",
}: {
  title: string;
  detail?: string;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <span className="inline-flex flex-col rounded-chip border border-chip-line bg-chip px-3 py-2.5 text-[11px] font-extrabold text-chip-fg squat:py-2 tiny:py-1.5">
      <span className="flex items-center gap-1.5">
        <i
          aria-hidden="true"
          className={clsx(
            "inline-block h-[7px] w-[7px] shrink-0 rounded-full",
            tone === "good" && "bg-good",
            tone === "warn" && "bg-warn",
            tone === "neutral" && "bg-fg-subtle",
          )}
        />
        <span className="uppercase tracking-wide">{title}</span>
      </span>
      {detail && (
        <span className="mt-0.5 text-[10px] font-semibold tabular-nums opacity-75">
          {detail}
        </span>
      )}
    </span>
  );
}
