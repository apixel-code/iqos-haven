import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type Database, type Tx } from "./client";

export class TransactionContentionError extends Error {
  readonly code = "TRANSACTION_RETRY_EXHAUSTED";
}
function retryable(error: unknown): boolean {
  // P2034 is Prisma's transaction write-conflict/deadlock result. Never retry arbitrary SQL errors.
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010" || !("meta" in error) || !error.meta || typeof error.meta !== "object")
    return false;
  const meta = error.meta as {
    code?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } };
  };
  const pgCode = meta.code ?? meta.driverAdapterError?.cause?.originalCode;
  return pgCode === "40P01" || pgCode === "40001";
}
/**
 * Short Read Committed unit of work. No external effects inside callbacks.
 * Resource order: idempotency → existing order → customer → settings/area → catalogue → coupon → variants.
 * Every retry starts an entirely new transaction, including commit-time failures.
 */
export async function withTransaction<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 2000,
        timeout: 10000,
      });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === 2)
        throw new TransactionContentionError("Transaction contention; retry the same command key");
      await delay(randomInt(10, 51) * (attempt + 1));
    }
  }
  throw new TransactionContentionError("Transaction contention");
}
export function sortedForLocking<T extends string | number>(ids: Iterable<T>): T[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
