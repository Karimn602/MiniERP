import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import { NavLink } from "./NavLink";
import { NetworkBadge } from "./NetworkBadge";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { SandboxBanner } from "./SandboxBanner";
import { IS_SANDBOX } from "../lib/appMode";
import { useOnline } from "../lib/network";
import { useLowStockCount } from "../state/lowStockBadge";
import { useTranslation } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Inline nav icons (no icon-library dependency; presentational only).
// ---------------------------------------------------------------------------
function Icon({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[1.05rem] w-[1.05rem]"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

const icons = {
  register: <Icon d="M3 6h18M3 6l1 13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1l1-13M9 10v6M15 10v6" />,
  products: <Icon d="M3.3 7 12 3l8.7 4-8.7 4-8.7-4ZM3.3 7v10l8.7 4 8.7-4V7M12 11v10" />,
  inventory: <Icon d="M4 7h16M4 12h16M4 17h16M8 4v3M16 4v3" />,
  purchases: <Icon d="M6 6h15l-1.5 9h-12L6 6Zm0 0L5 3H2m6 17a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
  suppliers: <Icon d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 10v-2a4 4 0 0 0-3-3.9M14 5.1A3 3 0 0 1 14 11" />,
  rate: <Icon d="M4 7h11m0 0-3-3m3 3-3 3M20 17H9m0 0 3-3m-3 3 3 3" />,
  shift: <Icon d="M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  sales: <Icon d="M4 19V5m0 14h16M8 16l3-4 3 2 4-6" />,
  returns: <Icon d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12H7" />,
  reports: <Icon d="M5 21V8m0 13h14M5 21H3m16 0V4m0 17h2M12 21v-9" />,
  manager: <Icon d="M3 13l9-9 9 9M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M9 21v-6h6v6" />,
};

/** Section label inside the rail. Quiet by design — it orients, it does not
 *  compete with the active nav pill. Matches the prototype's `.navcap`. */
function NavGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-2 pt-3.5 text-[9px] font-black uppercase tracking-[0.16em] text-rail-muted first:pt-0">
      {children}
    </p>
  );
}

export function AppShell() {
  const online = useOnline();
  const lowCount = useLowStockCount();
  const { t } = useTranslation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-page">
      {/* THE RAIL — 182px, per the approved layout.
          It INVERTS between appearances rather than being permanently dark:
          pale #FDF9F7 with ink text on Classic, near-black #0D0C0D with warm
          white on Midnight. All of it comes from the `rail-*` tokens, so this
          markup is written once and is correct in both. */}
      <aside className="flex w-[182px] shrink-0 flex-col bg-rail px-3 pb-4 pt-[19px] text-rail-fg">
        {/* Brand lockup — the prototype's poster wordmark: Impact, italic,
            tilted, red, over a hard shadow. Not official artwork; it is a type
            treatment standing in for the printed menu's logo. */}
        <div className="border-b border-rail-line px-1.5 pb-3.5">
          <span
            className="greaz-poster block w-max text-[35px] leading-none text-[#EF2442] [transform:rotate(-2deg)] rtl:[transform:rotate(2deg)]"
            style={{ textShadow: "1px 2px 0 #300C13" }}
          >
            GREAZ
          </span>
          <span
            // The training label was a fixed #F5C35A, picked against Midnight's
            // near-black rail. Classic's rail is #FDF9F7, where that gold is
            // 1.56:1 — the one warning that tells a cashier this is NOT the
            // real shop was the least readable text in the app. `warn-fg`
            // inverts with the rail: 5.61:1 on Classic, 12.38:1 on Midnight.
            className={
              IS_SANDBOX
                ? "mt-[7px] block text-[9px] font-extrabold uppercase tracking-[0.1em] text-warn-fg"
                : "mt-[7px] block text-[9px] font-extrabold uppercase tracking-[0.1em] text-rail-muted"
            }
          >
            {IS_SANDBOX ? "Counter · Training" : "Counter"}
          </span>
        </div>

        {/* Nav is grouped and LABELLED rather than split by bare rules. "Front
            of house" is the till; everything below it is the office. */}
        <nav className="flex-1 space-y-1 overflow-y-auto py-3">
          <NavGroupLabel>{t("nav.groupFrontOfHouse")}</NavGroupLabel>
          <NavLink to="/" icon={icons.register}>{t("nav.posRegister")}</NavLink>
          <NavLink to="/shift" icon={icons.shift}>{t("nav.shiftSummary")}</NavLink>

          <NavGroupLabel>{t("nav.groupMenuAndStock")}</NavGroupLabel>
          <NavLink to="/products" icon={icons.products}>{t("nav.products")}</NavLink>
          <NavLink to="/inventory" icon={icons.inventory}>
            <span className="flex items-center justify-between">
              <span>{t("nav.inventory")}</span>
              {lowCount !== null && lowCount > 0 && (
                <span className="ms-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-bold text-ink-900">
                  {lowCount}
                </span>
              )}
            </span>
          </NavLink>
          <NavLink to="/purchases" icon={icons.purchases}>{t("nav.purchases")}</NavLink>
          <NavLink to="/suppliers" icon={icons.suppliers}>{t("nav.suppliers")}</NavLink>

          <NavGroupLabel>{t("nav.groupBackOffice")}</NavGroupLabel>
          <NavLink to="/sales" icon={icons.sales}>{t("nav.salesHistory")}</NavLink>
          <NavLink to="/returns" icon={icons.returns}>{t("nav.returns")}</NavLink>
          <NavLink to="/reports" icon={icons.reports}>{t("nav.localReports")}</NavLink>
          <NavLink to="/exchange-rate" icon={icons.rate}>{t("nav.exchangeRate")}</NavLink>
          <NavLink to="/manager" icon={icons.manager} disabled={!online}>
            {t("nav.managerDashboard")} {online ? "" : "🔒"}
          </NavLink>
          {import.meta.env.DEV && <NavLink to="/_dev">🔧 Dev probe</NavLink>}
        </nav>

        <div className="flex items-center justify-between border-t border-rail-line px-1 pt-3 text-[10px] text-rail-muted">
          <span className="font-semibold tracking-tight">v0.1.0</span>
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Training strip — above the toolbar, so it sits on every routed
            screen. Identical in both appearances; renders null (and is
            compiled out) in production. */}
        <SandboxBanner />

        {/* TOP APPLICATION BAR. The appearance control lives here, at the end
            of the bar, reachable from the register without entering settings —
            not buried in the POS setup drawer. */}
        <header className="flex min-h-[56px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-[22px] py-2">
          <h1 className="font-eyebrow truncate text-[10px] text-fg-subtle">
            {t("common.workspace")}
          </h1>
          <div className="flex shrink-0 items-center gap-3">
            <NetworkBadge />
            <ThemeSwitcher />
          </div>
        </header>

        {/* Calm workspace. The prototype's own main padding and max width. */}
        <main className="min-h-0 flex-1 overflow-auto bg-page px-[22px] pb-[22px] pt-4 squat:pb-3 squat:pt-2.5 tiny:pb-2 tiny:pt-2">
          <div className="mx-auto flex h-full w-full max-w-[1580px] flex-col animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
