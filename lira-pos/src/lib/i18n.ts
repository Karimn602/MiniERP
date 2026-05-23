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
import en from "../locales/en";
import ar from "../locales/ar";

export type Lang = "en" | "ar";

const STORAGE_KEY = "lira-pos-lang";

const dictionaries: Record<Lang, typeof en> = { en, ar };

function resolve(obj: unknown, path: string): string {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== "object") return path;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : path;
}

function interpolate(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "ar" ? "ar" : "en";
    } catch {
      return "en";
    }
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (key: string, vars?: Record<string, string>): string => {
      const template = resolve(dictionaries[lang], key);
      return interpolate(template, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return createElement(I18nContext.Provider, { value }, children);
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within I18nProvider");
  return ctx;
}
