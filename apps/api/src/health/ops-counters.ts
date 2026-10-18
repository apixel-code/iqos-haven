/** Checkout and quote routes whose server errors the monitor watches (architecture §15). */
export const WATCHED_ROUTES = new Set(["POST /v1/store/orders", "POST /v1/store/cart/quote"]);
const BUCKET_MS = 60_000;
/** Ten one-minute buckets: the §15 "error rate over 10 minutes" window. */
export const WINDOW_BUCKETS = 10;

/**
 * In-process request counters for the ops monitor (roadmap step 125, ADR 0096). One API process
 * runs on the VPS, so its own counts are the store's. Expected rejections (4xx: sold out, coupon,
 * quote changed) are requests, not errors; only 5xx count as server errors.
 */
export class OpsCounters {
  private readonly buckets = new Map<number, { requests: number; serverErrors: number }>();

  /**
   * @param ordersOpen `CHECKOUT_SUBMISSION_ENABLED`: while checkout is closed the order route
   * answers 503 on purpose, so only quotes are counted.
   */
  constructor(private readonly ordersOpen = true) {}

  record(route: string, status: number, now = Date.now()) {
    if (!WATCHED_ROUTES.has(route)) return;
    if (!this.ordersOpen && route === "POST /v1/store/orders") return;
    const slot = Math.floor(now / BUCKET_MS);
    const bucket = this.buckets.get(slot) ?? { requests: 0, serverErrors: 0 };
    bucket.requests++;
    if (status >= 500) bucket.serverErrors++;
    this.buckets.set(slot, bucket);
    for (const key of this.buckets.keys())
      if (key <= slot - WINDOW_BUCKETS) this.buckets.delete(key);
  }

  snapshot(now = Date.now()) {
    const slot = Math.floor(now / BUCKET_MS);
    let requests = 0;
    let serverErrors = 0;
    for (const [key, bucket] of this.buckets)
      if (key > slot - WINDOW_BUCKETS) {
        requests += bucket.requests;
        serverErrors += bucket.serverErrors;
      }
    return { requests, serverErrors, windowSeconds: (WINDOW_BUCKETS * BUCKET_MS) / 1000 };
  }
}
