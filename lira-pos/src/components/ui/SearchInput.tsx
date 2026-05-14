import { useEffect, useState } from "react";
import { Input } from "./Input";

interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Debounce delay in ms. Default 200. */
  debounceMs?: number;
  /** Autofocus on mount. */
  autoFocus?: boolean;
}

/**
 * Search input with internal debouncing. The parent receives onChange calls
 * AFTER the user stops typing for debounceMs.
 *
 * Why debounce here vs. in the page? Search inputs are everywhere; centralizing
 * the timing means tuning it in one place. Also keeps page logic free of
 * setTimeout bookkeeping.
 *
 * Note: the displayed value tracks the user's typing in real-time (no lag),
 * but the onChange fires delayed. If the page wants the live typed value
 * for something else, pass it as `value` — this component will mirror it.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  debounceMs = 200,
  autoFocus,
}: SearchInputProps) {
  // Local state = what's displayed. Updates instantly with each keystroke.
  const [local, setLocal] = useState(value);

  // Sync local with external value when it changes (e.g. parent clears it).
  useEffect(() => {
    setLocal(value);
  }, [value]);

  // Debounced commit to parent.
  useEffect(() => {
    if (local === value) return; // No change to commit.
    const t = setTimeout(() => onChange(local), debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, debounceMs]);

  return (
    <Input
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      autoFocus={autoFocus}
      // Search-icon prefix — using a simple unicode glyph for now;
      // Phase 3+ can swap in a proper icon library if we want.
      prefix={<span aria-hidden>🔍</span>}
    />
  );
}