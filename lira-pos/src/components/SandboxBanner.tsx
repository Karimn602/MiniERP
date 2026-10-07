import { IS_SANDBOX } from "../lib/appMode";
import { useTranslation } from "../lib/i18n";

/**
 * The permanent TRAINING / SANDBOX warning strip.
 *
 * Renders nothing at all in a production build: `IS_SANDBOX` is a build-time
 * literal, so everything below the guard is dead code that Rollup eliminates.
 * That is also why the warning text is declared HERE rather than in
 * `src/locales/*.ts`. A locale dictionary is a live object that the i18n
 * provider reads wholesale, so a `sandbox.banner` key would survive
 * tree-shaking and ship the words "Training / Sandbox" inside the real shop's
 * bundle — inert, but indistinguishable from a leak to anyone auditing the
 * production build. Keeping the strings inside the dead branch means the
 * production bundle contains no sandbox text at all.
 *
 * It also makes the warning independent of the dictionary: `i18n.resolve`
 * falls back to echoing the key path, so a missing entry would have degraded
 * this banner to the literal text "sandbox.banner". A safety notice should not
 * have a failure mode that quiet.
 *
 * There is deliberately no dismiss control and no "hide" preference. The
 * banner's job is to stop an operator mistaking practice for the real shop,
 * and a banner that can be turned off is exactly as good as no banner on the
 * day someone turns it off.
 *
 * It is a normal flex child rather than a fixed overlay so it cannot cover the
 * content underneath it — a warning that hides the Pay button would get itself
 * removed.
 */
export function SandboxBanner() {
  const { lang } = useTranslation();
  if (!IS_SANDBOX) return null;

  const text =
    lang === "ar"
      ? "بيئة تدريب / تجريبية — البيانات غير حقيقية"
      : "Training / Sandbox — data is not real";

  return (
    <div
      role="status"
      aria-live="off"
      className="flex shrink-0 items-center justify-center gap-2.5 bg-amber-500 px-4 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.14em] text-amber-950 ring-1 ring-inset ring-amber-700/30"
      style={{
        // Diagonal hazard hatching. Inline because the stripe geometry is
        // fixed and not worth a Tailwind config entry for one element.
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(0,0,0,0.10) 0 10px, transparent 10px 20px)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      >
        <path d="M10.3 3.9 1.8 18.2A1.4 1.4 0 0 0 3 20.3h18a1.4 1.4 0 0 0 1.2-2.1L13.7 3.9a1.4 1.4 0 0 0-2.4 0Z" />
        <path d="M12 9v4M12 16.5v.01" />
      </svg>
      <span>{text}</span>
    </div>
  );
}
