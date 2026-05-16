import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { productsRepo } from "../db/repos/products";
import { useActiveContext } from "./activeContext";

/**
 * Counts active, non-service products at or below their reorder point.
 * Re-runs on route change (cheap heuristic — every nav re-fetches the
 * products list once, which the dashboard would do anyway).
 */
export function useLowStockCount(): number | null {
  const { storeId } = useActiveContext();
  const location = useLocation();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void productsRepo
      .listEnriched({ storeId, limit: 1000 })
      .then((products) => {
        if (cancelled) return;
        const n = products.filter(
          (p) =>
            !p.isService &&
            p.reorderPoint !== null &&
            p.quantityOnHand <= p.reorderPoint,
        ).length;
        setCount(n);
      })
      .catch(() => !cancelled && setCount(null));
    return () => {
      cancelled = true;
    };
  }, [storeId, location.pathname]);

  return count;
}