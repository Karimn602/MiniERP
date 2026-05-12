import { useEffect, useState } from "react";

/**
 * Online-status hook. Used to gate Manager Dashboard and (later) cloud sync.
 *
 * IMPORTANT: navigator.onLine only tells us whether the OS thinks it has a
 * network interface — not whether the internet is actually reachable.
 * For Phase 1 this is fine; in a later phase we'll add an active probe
 * against a known endpoint (e.g. Supabase health) for true reachability.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return online;
}