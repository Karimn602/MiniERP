import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { SandboxBanner } from "./components/SandboxBanner";
import { LockScreen } from "./components/LockScreen";
import { IS_SANDBOX } from "./lib/appMode";
import { adoptSessionContext, clearActiveContext } from "./state/activeContext";
import { useSession } from "./state/session";
import { useSessionWatch } from "./lib/useSessionWatch";
import { I18nProvider } from "./lib/i18n";
import { ThemeProvider } from "./lib/theme";
import * as auth from "./lib/auth";
import Enroll from "./pages/Enroll";
import Login from "./pages/Login";
import Recover from "./pages/Recover";
import PosRegister from "./pages/PosRegister";
import Products from "./pages/Products";
import Inventory from "./pages/Inventory";
import Purchases from "./pages/Purchases";
import Suppliers from "./pages/Suppliers";
import Drivers from "./pages/Drivers";
import ExchangeRate from "./pages/ExchangeRate";
import ShiftSummary from "./pages/ShiftSummary";
import SalesHistory from "./pages/SalesHistory";
import Returns from "./pages/Returns";
import LocalReports from "./pages/LocalReports";
import ManagerDashboard from "./pages/ManagerDashboard";
import DevProbe from "./pages/_Dev";
import SupplierDetail from "./pages/SupplierDetail";

/** Window title for the training build. Kept in step with the `app.windows[0].title`
 *  in `src-tauri/tauri.sandbox.conf.json`; this one also covers `npm run dev:sandbox`
 *  in a plain browser tab, where no Tauri window title exists. */
const SANDBOX_WINDOW_TITLE = "Greaz POS — SANDBOX — DATA IS NOT REAL";

/**
 * THE BOOT, REBUILT ON ONE COMMAND — Gate 2B, Stage A.1.
 *
 * It used to be three stages: `ensureDbReady()` (a `db_select` for the schema
 * version), then `hydrateActiveContext()` (two more, one of which chose the
 * user by `ORDER BY ... LIMIT 1`), then the router.
 *
 * All three were `db_select` calls, and `db_select` now requires a session — so
 * the old boot would be refused before it could draw a login screen to fix
 * itself with. `auth_status` therefore returns everything those three needed:
 * the schema version, the store, the accounts and the session. **The whole
 * pre-login boot is one command**, which is what lets the read channel be
 * session-gated with no allowlist of "harmless" pre-login queries — an
 * allowlist being a thing that grows.
 *
 * The screen is chosen by `auth.screenFor`, in one place, so this component
 * cannot develop a second opinion about it.
 *
 * ONE THING TO NOTICE ABOUT THE LOCK. It is rendered as an OVERLAY on top of a
 * mounted router, not instead of it. A locked till keeps its cart, its open
 * shift and any in-flight checkout attempt, because unmounting the register
 * would throw away the one recovery path there is for a sale whose answer was
 * lost. The lock costs the cashier the time it takes to type a passphrase and
 * nothing else.
 */
export default function App() {
  const refresh = useSession((s) => s.refresh);
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const loading = useSession((s) => s.loading);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    if (IS_SANDBOX) document.title = SANDBOX_WINDOW_TITLE;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep `activeContext` in step with the session, in both directions. A user
  // switch must not leave the previous person's id in the command payloads.
  const sessionUser = status?.session && !status.session.locked ? status.session : null;
  useEffect(() => {
    if (sessionUser) {
      adoptSessionContext({
        storeId: sessionUser.storeId,
        userId: sessionUser.userId,
      });
    } else {
      clearActiveContext();
    }
  }, [sessionUser]);

  useSessionWatch();

  const screen = error
    ? "error"
    : loading || !status
      ? "loading"
      : auth.screenFor(status);

  return (
    <ThemeProvider>
      <I18nProvider>
        {screen === "error" ? (
          // GZ-WAL-01's operator text arrives here: `auth_status` is refused
          // when startup validation failed, and the refusal IS the message that
          // says what to do. Shown verbatim, in a <pre>, because it is
          // multi-line and numbered.
          <div className="flex h-screen flex-col">
            <SandboxBanner />
            <div className="flex flex-1 items-center justify-center bg-danger-bg p-8">
              <div className="max-w-lg space-y-2 rounded-lg border border-danger-line bg-surface p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-danger-fg">Startup failed</h2>
                <pre className="whitespace-pre-wrap text-xs text-danger-fg">{error}</pre>
              </div>
            </div>
          </div>
        ) : screen === "loading" ? (
          <div className="flex h-screen flex-col">
            <SandboxBanner />
            <div className="flex flex-1 items-center justify-center text-slate-500">
              Starting Greaz…
            </div>
          </div>
        ) : screen === "enroll" ? (
          <Enroll />
        ) : screen === "login" ? (
          recovering ? (
            <Recover onCancel={() => setRecovering(false)} />
          ) : (
            <Login onRecover={() => setRecovering(true)} />
          )
        ) : (
          <>
            <BrowserRouter>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<PosRegister />} />

                  <Route path="products" element={<Products />} />
                  <Route path="inventory" element={<Inventory />} />
                  <Route path="purchases" element={<Purchases />} />

                  <Route path="suppliers" element={<Suppliers />} />
                  <Route path="drivers" element={<Drivers />} />
                  <Route path="suppliers/:id" element={<SupplierDetail />} />

                  <Route path="exchange-rate" element={<ExchangeRate />} />
                  <Route path="shift" element={<ShiftSummary />} />
                  <Route path="sales" element={<SalesHistory />} />
                  <Route path="returns" element={<Returns />} />
                  <Route path="reports" element={<LocalReports />} />
                  <Route path="manager" element={<ManagerDashboard />} />

                  {import.meta.env.DEV && <Route path="_dev" element={<DevProbe />} />}

                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>

            {/* The overlay. Mounted OVER the router, never in place of it. */}
            {screen === "locked" ? <LockScreen /> : null}

            {/* A credential the owner was told to change — set by a reset —
                is surfaced once they are in, not made a gate. Blocking the till
                on a password change at eight in the morning is how a shop ends
                up sharing one account. */}
            {status?.session?.mustChangeCredential ? (
              <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
                <div className="pointer-events-auto rounded-chip border border-line bg-surface px-4 py-2 text-xs shadow-soft">
                  Your passphrase was reset by the owner. Please change it.
                </div>
              </div>
            ) : null}
          </>
        )}
      </I18nProvider>
    </ThemeProvider>
  );
}
