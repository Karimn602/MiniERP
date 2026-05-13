import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ensureDbReady } from "./db/migrate";
import { hydrateActiveContext } from "./state/activeContext";
import PosRegister from "./pages/PosRegister";
import Products from "./pages/Products";
import Inventory from "./pages/Inventory";
import ExchangeRate from "./pages/ExchangeRate";
import ShiftSummary from "./pages/ShiftSummary";
import SalesHistory from "./pages/SalesHistory";
import LocalReports from "./pages/LocalReports";
import ManagerDashboard from "./pages/ManagerDashboard";
import DevProbe from "./pages/_Dev";

type BootStage = "db" | "context" | "ready" | "error";

export default function App() {
  const [stage, setStage] = useState<BootStage>("db");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await ensureDbReady();
        setStage("context");
        await hydrateActiveContext();
        setStage("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
    })();
  }, []);

  if (stage === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 p-8">
        <div className="max-w-lg space-y-2 rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-red-800">Startup failed</h2>
          <pre className="whitespace-pre-wrap text-xs text-red-900">{error}</pre>
        </div>
      </div>
    );
  }

  if (stage !== "ready") {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        {stage === "db" ? "Initializing database…" : "Loading workspace…"}
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<PosRegister />} />
          <Route path="products" element={<Products />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="exchange-rate" element={<ExchangeRate />} />
          <Route path="shift" element={<ShiftSummary />} />
          <Route path="sales" element={<SalesHistory />} />
          <Route path="reports" element={<LocalReports />} />
          <Route path="manager" element={<ManagerDashboard />} />
          <Route path="_dev" element={<DevProbe />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}