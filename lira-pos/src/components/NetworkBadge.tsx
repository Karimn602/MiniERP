import { useOnline } from "../lib/network";
import clsx from "clsx";

export function NetworkBadge() {
  const online = useOnline();
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset",
        online
          ? "bg-good-bg text-good-fg ring-good-line"
          : "bg-paper text-fg-muted ring-line",
      )}
    >
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          online ? "bg-good animate-pulse" : "bg-fg-subtle",
        )}
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}