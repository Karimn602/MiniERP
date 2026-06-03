import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={clsx(
        "inline-flex select-none items-center justify-center gap-1.5 rounded-lg font-semibold tracking-tight transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        variant === "primary" &&
          "bg-brand text-brand-fg shadow-soft hover:bg-brand-hover hover:shadow-card-hover focus-visible:ring-brand",
        variant === "secondary" &&
          "border border-slate-300 bg-white text-slate-700 shadow-soft hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-slate-400",
        variant === "ghost" &&
          "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-300",
        variant === "danger" &&
          "bg-red-600 text-white shadow-soft hover:bg-red-700 focus-visible:ring-red-500",
        className,
      )}
    >
      {children}
    </button>
  );
});