import { useState } from "react";
import { IS_SANDBOX } from "../lib/appMode";
import { useTranslation } from "../lib/i18n";

/**
 * ABOUT / CREDITS (V1.1).
 *
 * Deliberately discreet: a small link in the sidebar footer opens it, and the
 * credit appears nowhere else — not on a receipt, a kitchen ticket, a credit
 * memo, a shift report or the register itself.
 *
 * `DEVELOPER_PROFILE_URL` is EMPTY on purpose. A profile link is shown only
 * once somebody supplies the real address here; nothing is guessed.
 */
export const APP_VERSION = "1.1.0";
export const DEVELOPER_CREDIT = "Greaz POS — Developed by Omar Najjar";
export const DEVELOPER_PROFILE_URL = "";

export function AboutButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-semibold tracking-tight text-rail-muted underline-offset-2 hover:text-rail-fg hover:underline"
        title={t("about.open")}
      >
        v{APP_VERSION}
        {IS_SANDBOX ? " · Training" : ""}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("about.title")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-panel border border-line bg-surface p-5 text-fg shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-extrabold">{t("about.title")}</h2>
            <p className="mt-3 text-sm font-semibold">{DEVELOPER_CREDIT}</p>
            <p className="mt-1 text-xs text-fg-muted">
              {t("about.version", { version: APP_VERSION })}
              {IS_SANDBOX ? ` · ${t("about.training")}` : ""}
            </p>
            {DEVELOPER_PROFILE_URL && (
              <a
                href={DEVELOPER_PROFILE_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 inline-block text-xs text-brand-ink underline"
              >
                LinkedIn
              </a>
            )}
            <div className="mt-4 text-end">
              <button
                type="button"
                autoFocus
                onClick={() => setOpen(false)}
                className="rounded-chip border border-line px-3 py-1.5 text-xs font-bold hover:bg-paper"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
