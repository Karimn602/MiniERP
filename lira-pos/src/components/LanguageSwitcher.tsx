import { useTranslation, type Lang } from "../lib/i18n";
import clsx from "clsx";

const OPTIONS: { lang: Lang; label: string }[] = [
  { lang: "en", label: "EN" },
  { lang: "ar", label: "ع" },
];

export function LanguageSwitcher() {
  const { lang, setLang } = useTranslation();

  return (
    // Lives in the rail footer, and the rail inverts between appearances — so
    // this is built from `rail-*` tokens rather than the white-on-ink tints it
    // used before, which washed out completely on Classic's pale rail.
    <div className="inline-flex gap-0.5 rounded-chip bg-rail-hover p-0.5 ring-1 ring-inset ring-rail-line">
      {OPTIONS.map((opt) => (
        <button
          key={opt.lang}
          type="button"
          onClick={() => setLang(opt.lang)}
          className={clsx(
            "rounded-chip px-2 py-0.5 text-xs font-semibold transition-all",
            lang === opt.lang
              ? "bg-brand text-brand-fg shadow-soft"
              : "text-rail-muted hover:text-rail-fg",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
