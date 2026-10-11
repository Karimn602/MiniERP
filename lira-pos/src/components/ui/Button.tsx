import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /**
   * `lg` is for front-of-house: the POS Post Sale button and anything a cashier
   * hits at speed. Back-office screens stay on `md` / `sm`.
   */
  size?: "sm" | "md" | "lg";
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
        // No focus ring utilities here: the app has ONE focus treatment, the
        // prototype's amber outline, applied globally in index.css. It is the
        // only colour that stays visible against both warm white and #171617,
        // and a per-component ring would have had to be re-picked per theme.
        "inline-flex select-none items-center justify-center gap-1.5 rounded-chip font-semibold tracking-tight transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100",
        size === "sm" && "px-3 py-1.5 text-xs",
        size === "md" && "px-4 py-2 text-sm",
        // Tall and roomy — a gloved thumb on a trackpad, not a mouse pointer.
        size === "lg" && "px-5 py-3 text-base",
        variant === "primary" && "bg-brand text-brand-fg shadow-soft hover:bg-brand-hover",
        variant === "secondary" &&
          "border border-line bg-surface text-fg shadow-soft hover:bg-paper",
        variant === "ghost" && "bg-transparent text-fg-muted hover:bg-paper hover:text-fg",
        // Destructive stays distinguishable now that the BRAND is also red:
        // danger is darker, flatter and ringed, so "delete" never reads as
        // "the main action" at a glance. It gets its own token rather than
        // reusing `danger` text colour, which is a light rose on Midnight.
        variant === "danger" &&
          "bg-danger-solid text-danger-solid-fg shadow-soft ring-1 ring-inset ring-black/25 hover:brightness-110",
        className,
      )}
    >
      {children}
    </button>
  );
});
