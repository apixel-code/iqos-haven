"use client";

import { useEffect, useState } from "react";
import { adminDashboardSchema } from "@ih/contracts";
import type { NavCount } from "./navigation";

/**
 * The sidebar's attention counts (prototype `navItems`, parity G-A12): pending orders, low or
 * sold-out stock and reviews waiting, from the dashboard read, which leaves out (`null`) what
 * the signed-in user may not see. Read again every minute and on every page change; a failed
 * read keeps the last counts.
 */
export function useNavCounts(path: string): Partial<Record<NavCount, number>> {
  const [counts, setCounts] = useState<Partial<Record<NavCount, number>>>({});
  useEffect(() => {
    const controller = new AbortController();
    const read = () =>
      fetch("/api/v1/admin/dashboard", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const data = adminDashboardSchema.parse(await response.json());
          setCounts({
            ...(data.orders ? { pendingOrders: data.orders.open.pending } : {}),
            ...(data.stock ? { lowStock: data.stock.low + data.stock.out } : {}),
            ...(data.reviews ? { pendingReviews: data.reviews.pending } : {}),
          });
        })
        .catch(() => undefined);
    void read();
    const timer = window.setInterval(() => void read(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [path]);
  return counts;
}
