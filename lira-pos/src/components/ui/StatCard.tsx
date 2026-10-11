import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * KPI / summary stat tile. Replaces the per-page `MiniStat` / `StatCard`
 * markup that was duplicated across Reports, Shift, and Inventory.
 * Presentational only.
 */
export function StatCard({
  label,
  value,
  tone,
  hint,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Colours the value. Defaults to neutral slate. */
  tone?: "good" | "bad" | "warn" | "brand";
  hint?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-panel border border-line bg-surface p-4 shadow-panel transition-shadow hover:shadow-tile-hover",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          {label}
        </div>
        {icon && <div className="text-fg-subtle">{icon}</div>}
      </div>
      <div
        className={clsx(
          "mt-1.5 text-2xl font-bold tabular-nums tracking-tight",
          tone === "good"
            ? "text-good-fg"
            : tone === "bad"
              ? "text-danger-fg"
              : tone === "warn"
                ? "text-warn-fg"
                : tone === "brand"
                  ? "text-brand-ink"
                  : "text-fg",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}
