import { useOnline } from "../lib/network";
import clsx from "clsx";

export function NetworkBadge() {
  const online = useOnline();
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        online
          ? "bg-emerald-100 text-emerald-800"
          : "bg-slate-200 text-slate-700",
      )}
    >
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          online ? "bg-emerald-500" : "bg-slate-500",
        )}
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}