import type { ReactNode } from "react";
import clsx from "clsx";

type BadgeTone = "neutral" | "brand" | "good" | "warn" | "bad" | "info";

/**
 * Small status pill (active/inactive, low-stock, posted, etc.).
 * Presentational only.
 */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone === "neutral" && "bg-slate-100 text-slate-600 ring-slate-200",
        tone === "brand" && "bg-brand-50 text-brand-800 ring-brand-200",
        tone === "good" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
        tone === "warn" && "bg-amber-50 text-amber-700 ring-amber-200",
        tone === "bad" && "bg-red-50 text-red-700 ring-red-200",
        tone === "info" && "bg-sky-50 text-sky-700 ring-sky-200",
        className,
      )}
    >
      {children}
    </span>
  );
}
