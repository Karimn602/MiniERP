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
        tone === "neutral" && "bg-paper text-fg-muted ring-line",
        tone === "brand" && "bg-brand-soft text-brand-700 ring-brand-line",
        tone === "good" && "bg-good-bg text-good-fg ring-good-line",
        tone === "warn" && "bg-warn-bg text-warn-fg ring-warn-line",
        tone === "bad" && "bg-danger-bg text-danger-fg ring-danger-line",
        tone === "info" && "bg-info-bg text-info-fg ring-info-line",
        className,
      )}
    >
      {children}
    </span>
  );
}
