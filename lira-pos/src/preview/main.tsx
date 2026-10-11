/**
 * DESIGN PREVIEW ENTRY — NOT PART OF THE APPLICATION.
 *
 * Mounts the real `AppShell` (rail, training strip, top bar with the
 * appearance control) around a fixture-populated POS appearance, so both
 * approved themes can be checked against the reference screenshots at
 * 1366x768.
 *
 * `vite build` bundles `index.html` only, so nothing here ships. See
 * PosPreview.tsx for why this cannot reach the database.
 *
 * `MemoryRouter` rather than `BrowserRouter`: the preview has one route and
 * no URL to own, and a memory history keeps it from fighting the dev server
 * over the address bar.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { I18nProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import PosPreview from "./PosPreview";
import TallPreview from "./TallPreview";
import StatesPreview from "./StatesPreview";
import Pass2Preview from "./Pass2Preview";
import { THEME_STORAGE_KEY } from "../lib/theme";
import "../index.css";

// Preview-only: ?theme=midnight|classic seeds the stored preference so a
// screenshot of either appearance can be taken without driving the control by
// hand. It must write STORAGE, not just the <html> attribute — ThemeProvider
// is authoritative and will correct a DOM attribute that disagrees with the
// preference, which is exactly the behaviour that keeps a stale or tampered
// attribute from sticking in the real app.
const params = new URLSearchParams(location.search);
const forced = params.get("theme");
if (forced === "midnight" || forced === "classic") {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, forced);
  } catch {
    /* ignore */
  }
}
// ?lang=ar likewise, so RTL mirroring and the Arabic display-font fallback can
// be checked in a screenshot. The key is i18n's own.
const lang = params.get("lang");
if (lang === "ar" || lang === "en") {
  try {
    localStorage.setItem("lira-pos-lang", lang);
  } catch {
    /* ignore */
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                index
                element={
                  params.get("state") === "tall" ? (
                    <TallPreview />
                  ) : params.get("state") === "states" ? (
                    <StatesPreview />
                  ) : params.get("state") === "states2" ? (
                    <Pass2Preview />
                  ) : (
                    <PosPreview />
                  )
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
