import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import { NavLink } from "./NavLink";
import { NetworkBadge } from "./NetworkBadge";
import { LanguageSwitcher } from "./LanguageSwitcher";
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
      className="h-5 w-5"
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
  reports: <Icon d="M5 21V8m0 13h14M5 21H3m16 0V4m0 17h2M12 21v-9" />,
  manager: <Icon d="M3 13l9-9 9 9M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M9 21v-6h6v6" />,
};

export function AppShell() {
  const online = useOnline();
  const lowCount = useLowStockCount();
  const { t } = useTranslation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100">
      <aside className="flex w-64 flex-col border-e border-slate-200 bg-white">
        {/* Brand lockup */}
        <div className="flex items-center gap-3 border-b border-slate-200/70 px-5 py-[1.15rem]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-soft ring-1 ring-inset ring-brand-900/15">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[1.15rem] w-[1.15rem]"
            >
              <path d="M7 3h10a1 1 0 0 1 1 1v16l-2.2-1.3L13.6 20 12 18.7 10.4 20l-2.2-1.3L6 20V4a1 1 0 0 1 1-1Z" />
              <path d="M9.5 8h5M9.5 11.5h5" />
            </svg>
          </span>
          <div className="flex min-w-0 flex-col leading-none">
            <span className="text-[15px] font-bold tracking-tight text-slate-900">
              Lira <span className="text-brand">POS</span>
            </span>
            <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Retail Point of Sale
            </span>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          <NavLink to="/" icon={icons.register}>{t("nav.posRegister")}</NavLink>
          <NavLink to="/products" icon={icons.products}>{t("nav.products")}</NavLink>
          <NavLink to="/inventory" icon={icons.inventory}>
            <span className="flex items-center justify-between">
              <span>{t("nav.inventory")}</span>
              {lowCount !== null && lowCount > 0 && (
                <span className="ms-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {lowCount}
                </span>
              )}
            </span>
          </NavLink>

          <div className="mx-2 my-2.5 border-t border-slate-200/70" />
          <NavLink to="/purchases" icon={icons.purchases}>{t("nav.purchases")}</NavLink>
          <NavLink to="/suppliers" icon={icons.suppliers}>{t("nav.suppliers")}</NavLink>
          <NavLink to="/exchange-rate" icon={icons.rate}>{t("nav.exchangeRate")}</NavLink>

          <div className="mx-2 my-2.5 border-t border-slate-200/70" />
          <NavLink to="/shift" icon={icons.shift}>{t("nav.shiftSummary")}</NavLink>
          <NavLink to="/sales" icon={icons.sales}>{t("nav.salesHistory")}</NavLink>
          <NavLink to="/reports" icon={icons.reports}>{t("nav.localReports")}</NavLink>

          <div className="mx-2 my-2.5 border-t border-slate-200/70" />
          <NavLink to="/manager" icon={icons.manager} disabled={!online}>
            {t("nav.managerDashboard")} {online ? "" : "🔒"}
          </NavLink>
          {import.meta.env.DEV && <NavLink to="/_dev">🔧 Dev probe</NavLink>}
        </nav>

        <div className="flex items-center justify-between border-t border-slate-200/70 px-4 py-3.5 text-xs text-slate-400">
          <span className="font-medium tracking-tight">v0.1.0 · Phase 2D</span>
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 backdrop-blur">
          <h1 className="text-sm font-semibold tracking-tight text-slate-700">{t("common.workspace")}</h1>
          <NetworkBadge />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <div className="mx-auto w-full max-w-[1400px] animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
