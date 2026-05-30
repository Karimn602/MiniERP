import { useTranslation } from "../lib/i18n";

export default function ManagerDashboard() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h2 className="text-2xl font-semibold text-slate-900">{t("managerDashboard.title")}</h2>
      <p className="text-sm text-slate-600">{t("managerDashboard.subtitle")}</p>
    </div>
  );
}
