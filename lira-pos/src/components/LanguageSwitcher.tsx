import { useTranslation, type Lang } from "../lib/i18n";
import clsx from "clsx";

const OPTIONS: { lang: Lang; label: string }[] = [
  { lang: "en", label: "EN" },
  { lang: "ar", label: "ع" },
];

export function LanguageSwitcher() {
  const { lang, setLang } = useTranslation();

  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.lang}
          type="button"
          onClick={() => setLang(opt.lang)}
          className={clsx(
            "rounded-md px-2 py-0.5 text-xs font-semibold transition-all",
            lang === opt.lang
              ? "bg-brand text-brand-fg shadow-soft"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
