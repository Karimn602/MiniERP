/**
 * Build-time application mode.
 *
 * The SANDBOX build of Greaz is the SAME application as production — same
 * migrations, same posting commands, same costing, same reporting. The only
 * thing this flag is permitted to change is how the build IDENTIFIES itself:
 * the training banner, the window title, and (in `tauri.sandbox.conf.json`)
 * the bundle identifier that decides which `%APPDATA%` folder the database
 * lives in. It must never gate a business rule — a training session that
 * posts differently from production teaches the wrong thing, and a bug found
 * in sandbox would not reproduce in the real shop.
 *
 * The value is injected by `vite.config.ts` from Vite's own `--mode`, so
 * `vite build` yields "production" and `vite build --mode sandbox` yields
 * "sandbox". Because it is a literal string substitution rather than a
 * runtime lookup, `IS_SANDBOX` folds to `false` in a production build and
 * Rollup eliminates the banner markup entirely — the production bundle does
 * not merely skip the banner, it does not contain it.
 */
export type AppMode = "production" | "sandbox";

export const APP_MODE: AppMode =
  import.meta.env.VITE_APP_MODE === "sandbox" ? "sandbox" : "production";

export const IS_SANDBOX = import.meta.env.VITE_APP_MODE === "sandbox";
