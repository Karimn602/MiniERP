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
          className="block text-xs font-medium text-slate-700"
        >
          {label}
        </label>
      )}
      <div
        className={clsx(
          "flex items-stretch overflow-hidden rounded-md border bg-white shadow-sm transition-colors",
          "focus-within:ring-2",
          error
            ? "border-red-400 focus-within:border-red-500 focus-within:ring-red-100"
            : "border-slate-300 focus-within:border-brand focus-within:ring-brand/20",
        )}
      >
        {prefix && (
          <span className="flex items-center bg-slate-50 px-3 text-sm text-slate-500">
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
            "flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none",
            className,
          )}
        />
        {suffix && (
          <span className="flex items-center bg-slate-50 px-3 text-sm text-slate-500">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p id={errId} className="text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});