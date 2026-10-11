import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * Standard page header. Presentational only — pages keep all their own state.
 *
 * Two intensities, which is how this app keeps FRONT OF HOUSE and BACK OFFICE
 * apart without two design systems:
 *
 *   `plain` (default) — back office. Heading on the page background. Products,
 *     Inventory, Purchases, Suppliers, Shift, Sales, Reports. Calm, dense,
 *     professional. The brand shows up only in the actions and links.
 *
 *   `hero` — front of house: the approved restaurant banner. Used by the POS
 *     Register, the one screen a cashier lives on, and deliberately nowhere
 *     else — if every page got the band it would stop meaning "you are
 *     selling".
 *
 * The band is where the two appearances diverge most. On Classic it is warm
 * paper inside a border with ink type and a red kicker; on Midnight it is a
 * solid #BD1029 field with white type. Both come out of the `banner-*` tokens,
 * so this is one component, not two.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  variant = "plain",
  className,
}: {
  title: string;
  subtitle?: string;
  /** Small uppercase label above the title. */
  eyebrow?: string;
  actions?: ReactNode;
  variant?: "plain" | "hero";
  className?: string;
}) {
  if (variant === "hero") {
    return (
      <div
        className={clsx(
          // The prototype's asymmetric banner radius: generous at the top,
          // tight where the menu meets it.
          "relative flex min-h-[78px] flex-wrap items-center justify-between gap-4 overflow-hidden rounded-t-[17px] rounded-b-panel border border-line bg-banner px-[19px] py-[15px] text-banner-fg",
          "squat:min-h-[56px] squat:px-[15px] squat:py-2 tiny:min-h-0 tiny:py-1.5",
          className,
        )}
      >
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-banner-kicker">
              {eyebrow}
            </p>
          )}
          <h2 className="greaz-poster mt-1 text-[29px] leading-none squat:text-[25px] tiny:mt-0.5 tiny:text-[21px]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] text-banner-sub">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    );
  }

  return (
    <div
      className={clsx("flex flex-wrap items-end justify-between gap-4", className)}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-eyebrow text-[10px] text-brand-ink">{eyebrow}</p>
        )}
        <h2
          className={clsx(
            "greaz-display text-2xl uppercase text-fg",
            eyebrow && "mt-1",
          )}
        >
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-end gap-2">{actions}</div>}
    </div>
  );
}
