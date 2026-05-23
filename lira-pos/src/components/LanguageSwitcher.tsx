import { useTranslation, type Lang } from "../lib/i18n";
import clsx from "clsx";

const OPTIONS: { lang: Lang; label: string }[] = [
  { lang: "en", label: "EN" },
  { lang: "ar", label: "ع" },
];

export function LanguageSwitcher() {
  const { lang, setLang } = useTranslation();

  return (
    <div className="flex gap-1">
      {OPTIONS.map((opt) => (
        <button
          key={opt.lang}
          type="button"
          onClick={() => setLang(opt.lang)}
          className={clsx(
            "rounded px-2 py-0.5 text-xs font-medium transition-colors",
            lang === opt.lang
              ? "bg-brand text-brand-fg"
              : "text-slate-500 hover:bg-slate-100",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
