import { stockReconciliationMismatches, type Database } from "@ih/db";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

/**
 * Hourly ledger reconciliation (roadmap step 53, ADR 0023). A variant balance must equal the sum
 * of its movements and the balance of its latest one; the database trigger guarantees it, so any
 * row here is a bug or tampering. Read-only and therefore idempotent: it reports through an
 * error log (IDs only) for alerting and changes nothing.
 */
export function createStockReconciliationJob(options: { db: Database; log: Logger }): ScheduledJob {
  const { db, log } = options;
  return {
    name: "inventory.reconciliation",
    spec: { kind: "interval", everyMs: 60 * 60_000 },
    catchUp: 1,
    async run() {
      const mismatches = await stockReconciliationMismatches(db);
      if (!mismatches.length) {
        log.info("stock ledger reconciled");
        return;
      }
      log.error(
        {
          mismatches: mismatches.length,
          variantIds: mismatches.slice(0, 20).map((row) => row.variantId),
        },
        "stock ledger mismatch",
      );
    },
  };
}
