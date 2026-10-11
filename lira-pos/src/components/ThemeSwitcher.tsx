import clsx from "clsx";
import { useTheme, type Theme } from "../lib/theme";
import { useTranslation } from "../lib/i18n";

/**
 * The appearance control — Classic / Midnight.
 *
 * Placement is a requirement, not a preference: top-right of the application
 * header, so a cashier can reach it from the register without going into an
 * administrative settings screen in the middle of service.
 *
 * Shape follows the approved prototype's `labnav`: two plainly-labelled
 * buttons rather than an unlabelled icon toggle, because a bare sun/moon does
 * not say which state you are currently in. Each carries its glyph AND its
 * word, `aria-pressed` states the current choice to a screen reader, and the
 * pair is wrapped in a labelled group so the control announces what it
 * governs.
 *
 * Mouse, keyboard and touch all work: they are ordinary buttons in source
 * order, they take the app-wide amber focus ring, and the targets are sized
 * for a finger rather than for a pointer. Labels go through `t()`, and the row
 * is laid out with logical properties so it mirrors under Arabic.
 *
 * This is the ONLY component in the app that subscribes to theme state —
 * everything else is painted by CSS custom properties — which is what makes a
 * switch incapable of remounting the register or disturbing the cart.
 */
export function ThemeSwitcher({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const options: { value: Theme; glyph: string; label: string; hint: string }[] = [
    {
      value: "midnight",
      glyph: "☾",
      label: t("theme.midnight"),
      hint: t("theme.switchToMidnight"),
    },
    {
      value: "classic",
      glyph: "☀",
      label: t("theme.classic"),
      hint: t("theme.switchToClassic"),
    },
  ];

  return (
    <div
      role="group"
      aria-label={t("theme.group")}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-chip border border-line bg-paper p-1",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            aria-pressed={selected}
            aria-label={opt.hint}
            title={opt.hint}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1.5 text-[11px] font-extrabold transition-colors",
              selected
                ? "bg-brand text-brand-fg"
                : "text-fg-muted hover:bg-surface hover:text-fg",
            )}
          >
            <span aria-hidden="true" className="text-xs leading-none">
              {opt.glyph}
            </span>
            <span className="whitespace-nowrap">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
