import { NavLink as RRNavLink } from "react-router-dom";
import clsx from "clsx";
import type { ReactNode } from "react";

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
      <span className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400">
        {icon && <span className="flex h-5 w-5 items-center justify-center opacity-60">{icon}</span>}
        <span className="flex-1">{children}</span>
      </span>
    );
  }
  return (
    <RRNavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        clsx(
          "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-brand text-brand-fg shadow-soft"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        )
      }
    >
      {({ isActive }) => (
        <>
          {icon && (
            <span
              className={clsx(
                "flex h-5 w-5 items-center justify-center transition-colors",
                isActive ? "text-brand-fg" : "text-slate-400 group-hover:text-slate-600",
              )}
            >
              {icon}
            </span>
          )}
          <span className="flex-1">{children}</span>
        </>
      )}
    </RRNavLink>
  );
}
