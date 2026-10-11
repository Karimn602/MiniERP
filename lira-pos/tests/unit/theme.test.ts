/**
 * Appearance preference — resolution, fallback and storage namespacing.
 *
 * These are the parts of the theme system that can be wrong without anyone
 * noticing until a cashier restarts the till: a stale or corrupt stored value
 * leaving the app unstyled, a throwing storage accessor taking the boot down,
 * or a sandbox build and a production build sharing one key on localhost and
 * overwriting each other's choice.
 *
 * Scope note: the Vitest environment here is `node`, with no DOM and no React
 * renderer available in this repo, so `ThemeProvider` and `applyTheme` are not
 * exercised. The invariant they carry — that a switch rewrites one attribute
 * and re-renders nothing — is structural (no component reads the theme to pick
 * a className) and is verified by hand against the running app, not here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
} from "../../src/lib/theme";

describe("resolveTheme", () => {
  it("selects Midnight only for the exact string", () => {
    expect(resolveTheme("midnight")).toBe("midnight");
  });

  it("selects Classic for its own name", () => {
    expect(resolveTheme("classic")).toBe("classic");
  });

  it("defaults to Classic when nothing is stored", () => {
    expect(resolveTheme(null)).toBe("classic");
    expect(resolveTheme(undefined)).toBe("classic");
  });

  it("defaults to Classic for anything unrecognised", () => {
    // A stale value from an older build, a truncated write, a value some other
    // tool left in the key, or a type that is not a string at all.
    for (const raw of [
      "",
      " midnight",
      "Midnight",
      "MIDNIGHT",
      "dark",
      "greaz-cream",
      "{}",
      0,
      1,
      true,
      {},
      [],
      Symbol("midnight"),
    ]) {
      expect(resolveTheme(raw)).toBe("classic");
    }
  });

  it("agrees with the documented default", () => {
    expect(DEFAULT_THEME).toBe("classic");
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
  });
});

describe("storage", () => {
  const original = globalThis.localStorage;

  function installStore(impl: Partial<Storage>): void {
    Object.defineProperty(globalThis, "localStorage", {
      value: impl,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    const map = new Map<string, string>();
    installStore({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      configurable: true,
      writable: true,
    });
  });

  it("round-trips a stored appearance", () => {
    writeStoredTheme("midnight");
    expect(readStoredTheme()).toBe("midnight");
    writeStoredTheme("classic");
    expect(readStoredTheme()).toBe("classic");
  });

  it("reads Classic when the key was never written", () => {
    expect(readStoredTheme()).toBe("classic");
  });

  it("falls back to Classic over a corrupt stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "¯\\_(ツ)_/¯");
    expect(readStoredTheme()).toBe("classic");
  });

  it("survives a storage accessor that throws", () => {
    // Private windows and blocked site data both do this.
    installStore({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(readStoredTheme()).toBe("classic");
    expect(() => writeStoredTheme("midnight")).not.toThrow();
  });

  it("namespaces the key by build identity", () => {
    // `npm run dev` and `npm run dev:sandbox` share localhost:1420, and so
    // share one localStorage. Without the suffix a training build would
    // silently restyle the production build opened next.
    expect(THEME_STORAGE_KEY).toMatch(/^greaz\.ui\.appearance\.v1\.(production|sandbox)$/);
  });

  it("writes nothing outside its own key", () => {
    const seen: string[] = [];
    installStore({
      getItem: () => null,
      setItem: (k: string) => void seen.push(k),
    });
    writeStoredTheme("midnight");
    expect(seen).toEqual([THEME_STORAGE_KEY]);
  });
});

describe("the preference is not financial data", () => {
  it("does not reach for the database layer", async () => {
    // A cosmetic preference must never land in SQLite: `app_settings` is
    // replicated, audited state and an appearance is neither. Importing the
    // module must not pull the DB client in with it.
    const spy = vi.fn();
    vi.doMock("../../src/db/client", () => {
      spy();
      return {};
    });
    vi.resetModules();
    await import("../../src/lib/theme");
    expect(spy).not.toHaveBeenCalled();
    vi.doUnmock("../../src/db/client");
  });
});
