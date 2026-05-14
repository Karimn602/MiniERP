import { Outlet } from "react-router-dom";
import { NavLink } from "./NavLink";
import { NetworkBadge } from "./NetworkBadge";
import { useOnline } from "../lib/network";

export function AppShell() {
  const online = useOnline();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <span className="text-lg font-semibold text-brand">Lira POS</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          <NavLink to="/">POS Register</NavLink>
          <NavLink to="/products">Products</NavLink>
          <NavLink to="/inventory">Inventory</NavLink>
          <NavLink to="/purchases">Purchases</NavLink>
          <NavLink to="/suppliers">Suppliers</NavLink>
          <NavLink to="/exchange-rate">Exchange Rate</NavLink>
          <NavLink to="/shift">Shift Summary</NavLink>
          <NavLink to="/sales">Sales History</NavLink>
          <NavLink to="/reports">Local Reports</NavLink>
          <div className="my-2 border-t border-slate-200" />
          <NavLink to="/manager" disabled={!online}>
            Manager Dashboard {online ? "" : "🔒"}
          </NavLink>
          {import.meta.env.DEV && <NavLink to="/_dev">🔧 Dev probe</NavLink>}
        </nav>
        <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
          v0.1.0 · Phase 2C
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <h1 className="text-base font-medium text-slate-800">Workspace</h1>
          <NetworkBadge />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
