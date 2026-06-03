import { useOnline } from "../lib/network";
import clsx from "clsx";

export function NetworkBadge() {
  const online = useOnline();
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset",
        online
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : "bg-slate-100 text-slate-600 ring-slate-200",
      )}
    >
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          online ? "bg-emerald-500 animate-pulse" : "bg-slate-400",
        )}
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}