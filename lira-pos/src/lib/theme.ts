/**
 * GREAZ appearance (theme) — Classic / Midnight.
 *
 * Two approved appearances, one set of components. Classic (C) is light and is
 * the default; Midnight (B) is dark and is chosen by the cashier during
 * service. See design-references/greaz-theme-references/.
 *
 * WHAT A THEME SWITCH IS ALLOWED TO DO
 *
 * Exactly one thing: rewrite `data-theme` on <html>. Every colour, radius and
 * shadow in the app resolves through a CSS custom property keyed off that
 * attribute (see index.css), so the browser re-paints and React is not
 * involved. That is the whole safety argument, and it is structural rather
 * than a promise:
 *
 *   - No component reads the theme to decide a className, so no component
 *     outside the switcher subscribes to this context and nothing re-renders.
 *   - Nothing remounts, so the POS keeps its cart lines, its parked carts, its
 *     typed USD/LBP cash, its discount state and its DOM focus.
 *   - No query runs, no `invoke` is called, no receipt number moves, nothing
 *     is written to SQLite. The preference is a device-local UI setting and
 *     lives in localStorage, not in `app_settings`.
 *
 * Deliberately modelled on `lib/i18n.ts`: same provider shape, same
 * try/catch-wrapped storage, same "write the attribute from an effect". One
 * pattern for device-local UI preferences, not two.
 */
import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { APP_MODE } from "./appMode";

export type Theme = "classic" | "midnight";

/** The documented default on first launch, and the fallback for anything we
 *  cannot make sense of. */
export const DEFAULT_THEME: Theme = "classic";

/**
 * Where the preference lives, namespaced by build identity.
 *
 * A Tauri build already partitions WebView storage by bundle identifier, so
 * two installed apps cannot see each other's key. The suffix covers the case
 * that partitioning does NOT: `npm run dev` and `npm run dev:sandbox` are both
 * served from localhost:1420 and therefore share one origin and one
 * localStorage. Without it, switching a sandbox build to Midnight would also
 * switch the production build a developer opens next.
 */
export const THEME_STORAGE_KEY = `greaz.ui.appearance.v1.${APP_MODE}`;

/**
 * Coerce anything at all to a valid appearance.
 *
 * Only the exact string "midnight" selects Midnight. `null` (never set),
 * a stale value from an older build, a half-written string, a value some other
 * tool put in the key — all of it resolves to Classic rather than throwing or
 * leaving the app unstyled. An appearance preference is not worth a failed
 * boot.
 */
export function resolveTheme(raw: unknown): Theme {
  return raw === "midnight" ? "midnight" : DEFAULT_THEME;
}

/** Read the stored preference. A throwing accessor (private mode, blocked site
 *  data) is indistinguishable from "not set", which is the right answer. */
export function readStoredTheme(): Theme {
  try {
    return resolveTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the preference. Failure is silent and non-fatal: the appearance
 *  still applies for this session, it simply will not survive a restart. */
export function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore — see above */
  }
}

/** Apply an appearance to the document. The ONLY DOM write a switch performs. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialised from storage rather than from the DOM attribute the inline
  // boot script in index.html already set, so the two cannot drift if the
  // script is ever removed.
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeStoredTheme(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "midnight" ? "classic" : "midnight";
      writeStoredTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
