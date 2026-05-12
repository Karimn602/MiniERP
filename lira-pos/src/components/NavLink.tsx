import { NavLink as RRNavLink } from "react-router-dom";
import clsx from "clsx";
import type { ReactNode } from "react";

export function NavLink({
  to,
  children,
  disabled = false,
}: {
  to: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="block rounded-md px-3 py-2 text-sm text-slate-400 cursor-not-allowed">
        {children}
      </span>
    );
  }
  return (
    <RRNavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          "block rounded-md px-3 py-2 text-sm transition-colors",
          isActive
            ? "bg-brand text-brand-fg"
            : "text-slate-700 hover:bg-slate-200",
        )
      }
    >
      {children}
    </RRNavLink>
  );
}