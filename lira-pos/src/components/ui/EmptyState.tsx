import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * Friendly empty state for tables / lists. Presentational only.
 * Defaults to a soft inbox glyph; pass `icon` to override.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? (
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
            <path
              d="M3 8.5 5 4h14l2 4.5M3 8.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5M3 8.5h5l1.2 2.2h5.6L16 8.5h5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
