import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_SANDBOX } from "../lib/appMode";
import { useTranslation } from "../lib/i18n";

/**
 * ABOUT / CREDITS (V1.1, profile link V1.1.1).
 *
 * Deliberately discreet: a small link in the sidebar footer opens it, and the
 * credit appears nowhere else — not on a receipt, a kitchen ticket, a credit
 * memo, a shift report or the register itself.
 *
 * The profile opens in the system browser through `open_developer_profile`,
 * a Rust command that takes NO argument and opens one fixed address
 * (`src-tauri/src/about.rs`). The renderer holds no opener permission, so it
 * cannot open anything else; `DEVELOPER_PROFILE_URL` here is the display copy
 * of that address and is pinned to it by tests on both sides. It is rendered
 * as a button, not an `<a href>`: a link inside the WebView would navigate
 * the till itself (or a new WebView window) instead of the browser.
 */
export const APP_VERSION = "1.1.1";
export const DEVELOPER_NAME = "Omar Najjar";
export const DEVELOPER_TAGLINE = "Software Engineering & Business Solutions";
export const DEVELOPER_PROFILE_URL = "https://www.linkedin.com/in/omar-s-najjar-1b7994259/";

export function openDeveloperProfile(): Promise<void> {
  return invoke<void>("open_developer_profile");
}

export function AboutButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [linkError, setLinkError] = useState(false);
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
            <div dir="ltr" className="mt-3 text-start">
              <p className="text-sm font-semibold">Developed by {DEVELOPER_NAME}</p>
              <p className="text-xs text-fg-muted">{DEVELOPER_TAGLINE}</p>
              <p className="mt-1 text-xs text-fg-muted">
                LinkedIn:{" "}
                <button
                  type="button"
                  title={DEVELOPER_PROFILE_URL}
                  data-href={DEVELOPER_PROFILE_URL}
                  onClick={() => {
                    setLinkError(false);
                    openDeveloperProfile().catch(() => setLinkError(true));
                  }}
                  className="font-semibold text-brand-ink underline underline-offset-2 hover:opacity-80"
                >
                  View Developer Profile
                </button>
              </p>
              {linkError && (
                <p role="alert" className="mt-1 text-xs text-fg-muted">
                  {DEVELOPER_PROFILE_URL}
                </p>
              )}
            </div>
            <p className="mt-3 text-xs text-fg-muted">
              {t("about.version", { version: APP_VERSION })}
              {IS_SANDBOX ? ` · ${t("about.training")}` : ""}
            </p>
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
