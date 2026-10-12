import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type Database, type Tx } from "./client";

export class TransactionContentionError extends Error {
  readonly code = "TRANSACTION_RETRY_EXHAUSTED";
}
/**
 * Thrown inside a unit of work when what it read is no longer what it locked. The whole
 * transaction is rolled back and started again, like a deadlock.
 */
export class TransactionRestartError extends Error {}
function retryable(error: unknown): boolean {
  if (error instanceof TransactionRestartError) return true;
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
const unitsOfWork = new WeakSet<object>();
/** True only for a transaction client handed out by withTransaction(), never the root client. */
export function isUnitOfWork(tx: unknown): boolean {
  return typeof tx === "object" && tx !== null && unitsOfWork.has(tx);
}
/**
 * Short Read Committed unit of work. No external effects inside callbacks.
 * Resource order: idempotency → existing order → customer → settings/area → catalogue → coupon → variants.
 * Every retry starts an entirely new transaction, including commit-time failures.
 */
export async function withTransaction<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tracked = (tx: Tx) => {
        unitsOfWork.add(tx);
        return work(tx);
      };
      return await db.$transaction(tracked, {
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
/**
 * The resource order of commerce transactions (architecture §5). A transaction takes these
 * groups front to back and may skip any; within a group, rows are locked in sorted ID order.
 * Two transactions that both follow it can wait for each other but can never deadlock.
 */
export const LOCK_GROUPS = [
  "idempotency",
  "order",
  "customer",
  "delivery",
  "catalogue",
  "coupon",
  "variants",
] as const;
export type LockGroup = (typeof LOCK_GROUPS)[number];
/** A lock primitive was called after one of a later group: a programming error, never retried. */
export class LockOrderError extends Error {
  constructor(
    readonly attempted: LockGroup,
    readonly after: LockGroup,
  ) {
    super(`Lock order violated: ${attempted} requested after ${after}`);
  }
}
const lockStage = new WeakMap<object, number>();
/**
 * Called by every commerce lock primitive before it takes its locks. Entering a group again, or
 * a later one, is fine; entering an earlier group after a later one throws before any statement
 * runs, so a wrong sequence fails in the first test that walks it instead of deadlocking in
 * production.
 */
export function enterLockGroup(tx: unknown, group: LockGroup): void {
  if (!isUnitOfWork(tx)) throw new Error("Commerce locks require a unit of work");
  const stage = LOCK_GROUPS.indexOf(group);
  const reached = lockStage.get(tx as object) ?? -1;
  if (stage < reached) throw new LockOrderError(group, LOCK_GROUPS[reached]!);
  lockStage.set(tx as object, stage);
}
/** Whether the transaction has entered `group` or a later one. */
export function hasReachedLockGroup(tx: unknown, group: LockGroup): boolean {
  const reached = typeof tx === "object" && tx !== null ? lockStage.get(tx) : undefined;
  return reached !== undefined && reached >= LOCK_GROUPS.indexOf(group);
}
/** The furthest group this transaction has entered, or null before the first. */
export function reachedLockGroup(tx: unknown): LockGroup | null {
  const reached = typeof tx === "object" && tx !== null ? lockStage.get(tx) : undefined;
  return reached === undefined ? null : LOCK_GROUPS[reached]!;
}
export function sortedForLocking<T extends string | number>(ids: Iterable<T>): T[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
