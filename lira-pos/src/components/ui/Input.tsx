import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: string;
  hint?: string;
  error?: string | null;
  suffix?: ReactNode;
  prefix?: ReactNode;
}

/**
 * Text field.
 *
 * The fill is `paper`, not `surface`: the approved prototype insets its inputs
 * against the panel they sit on (`--paper` on Classic, #221D1D on Midnight)
 * rather than making them the same white as the card. On Midnight that inset
 * is the only thing that marks a field as a field.
 *
 * The typed value is deliberately NOT the display face — Impact has no Arabic
 * glyphs and is wrong for a number a cashier types and reads back.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, prefix, suffix, className, id, ...rest },
  ref,
) {
  const reactId = String(id ?? Math.random().toString(36).slice(2));
  const hintId = `${reactId}-hint`;
  const errId = `${reactId}-err`;

  return (
    <div className="space-y-1">
      {label && (
        <label
          htmlFor={reactId}
          className="block text-[11px] font-extrabold text-fg squat:text-[10px]"
        >
          {label}
        </label>
      )}
      <div
        className={clsx(
          "flex items-stretch overflow-hidden rounded-chip border bg-paper transition-colors",
          error
            ? "border-danger"
            : "border-line hover:border-fg-subtle focus-within:border-brand",
        )}
      >
        {prefix && (
          <span className="flex shrink-0 items-center border-e border-line px-3 text-sm font-medium text-fg-muted">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={reactId}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? errId : hint ? hintId : undefined}
          {...rest}
          className={clsx(
            "w-full min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-fg placeholder-fg-subtle focus:outline-none squat:py-1.5",
            className,
          )}
        />
        {suffix && (
          <span className="flex shrink-0 items-center border-s border-line px-3 text-sm font-medium text-fg-muted">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p id={errId} className="text-xs text-danger-fg">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
