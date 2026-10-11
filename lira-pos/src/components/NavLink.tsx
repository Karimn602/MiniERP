import { NavLink as RRNavLink } from "react-router-dom";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * Sidebar navigation item.
 *
 * Active is a solid brand-red pill — the single loudest thing in the rail, so
 * "where am I" is answerable from across the counter. Inactive is the rail's
 * own muted foreground, lifting to full `rail-fg` on hover; it never reaches
 * the active pill's weight.
 *
 * Everything here is a `rail-*` token because the rail inverts between
 * appearances (pale on Classic, near-black on Midnight). The previous version
 * hard-coded `text-ink-200` and `hover:bg-white/[0.07]`, which only ever made
 * sense on a dark rail and would have been invisible on Classic's #FDF9F7.
 */
export function NavLink({
  to,
  children,
  icon,
  disabled = false,
}: {
  to: string;
  children: ReactNode;
  /** Optional leading icon (presentational). */
  icon?: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="flex cursor-not-allowed items-center gap-2.5 rounded-chip px-2.5 py-3 text-xs font-bold text-rail-muted opacity-60">
        {icon && <span className="flex h-[1.05rem] w-[1.05rem] items-center justify-center opacity-60">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </span>
    );
  }
  return (
    <RRNavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        clsx(
          "group flex items-center gap-2.5 rounded-chip px-2.5 py-3 text-xs font-bold tracking-tight transition-colors",
          isActive
            ? "bg-brand text-brand-fg shadow-soft"
            : "text-rail-fg/85 hover:bg-rail-hover hover:text-rail-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          {icon && (
            <span
              className={clsx(
                "flex h-[1.05rem] w-[1.05rem] shrink-0 items-center justify-center transition-colors",
                isActive ? "text-brand-fg" : "text-rail-muted group-hover:text-brand-ink",
              )}
            >
              {icon}
            </span>
          )}
          <span className="min-w-0 flex-1">{children}</span>
        </>
      )}
    </RRNavLink>
  );
}
