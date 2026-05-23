import { Outlet } from "react-router-dom";
import { NavLink } from "./NavLink";
import { NetworkBadge } from "./NetworkBadge";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useOnline } from "../lib/network";
import { useLowStockCount } from "../state/lowStockBadge";
import { useTranslation } from "../lib/i18n";

export function AppShell() {
  const online = useOnline();
  const lowCount = useLowStockCount();
  const { t } = useTranslation();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="flex w-60 flex-col border-e border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <span className="text-lg font-semibold text-brand">Lira POS</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          <NavLink to="/">{t("nav.posRegister")}</NavLink>
          <NavLink to="/products">{t("nav.products")}</NavLink>
          <NavLink to="/inventory">
            <span className="flex items-center justify-between">
              <span>{t("nav.inventory")}</span>
              {lowCount !== null && lowCount > 0 && (
                <span className="ms-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                  {lowCount}
                </span>
              )}
            </span>
          </NavLink>
          <NavLink to="/purchases">{t("nav.purchases")}</NavLink>
          <NavLink to="/suppliers">{t("nav.suppliers")}</NavLink>
          <NavLink to="/exchange-rate">{t("nav.exchangeRate")}</NavLink>
          <NavLink to="/shift">{t("nav.shiftSummary")}</NavLink>
          <NavLink to="/sales">{t("nav.salesHistory")}</NavLink>
          <NavLink to="/reports">{t("nav.localReports")}</NavLink>
          <div className="my-2 border-t border-slate-200" />
          <NavLink to="/manager" disabled={!online}>
            {t("nav.managerDashboard")} {online ? "" : "🔒"}
          </NavLink>
          {import.meta.env.DEV && <NavLink to="/_dev">🔧 Dev probe</NavLink>}
        </nav>
        <div className="flex items-center justify-between border-t border-slate-200 p-3 text-xs text-slate-500">
          <span>v0.1.0 · Phase 2D</span>
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <h1 className="text-base font-medium text-slate-800">{t("common.workspace")}</h1>
          <NetworkBadge />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
