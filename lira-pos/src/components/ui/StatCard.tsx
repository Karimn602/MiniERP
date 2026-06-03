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
        "rounded-xl border border-slate-200/80 bg-white p-4 shadow-card transition-shadow hover:shadow-card-hover",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </div>
        {icon && <div className="text-slate-300">{icon}</div>}
      </div>
      <div
        className={clsx(
          "mt-1.5 text-2xl font-bold tabular-nums tracking-tight",
          tone === "good"
            ? "text-emerald-600"
            : tone === "bad"
              ? "text-red-600"
              : tone === "warn"
                ? "text-amber-600"
                : tone === "brand"
                  ? "text-brand"
                  : "text-slate-900",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}
