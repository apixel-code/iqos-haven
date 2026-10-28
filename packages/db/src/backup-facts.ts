import { Prisma, type DbExecutor } from "./client";

/**
 * Facts a backup records and a restore drill compares (roadmap step 126, ADR 0098). Counts,
 * totals, the migration head and object keys only: no names, contacts or addresses leave this
 * function, so a manifest can sit next to the encrypted files without exposing customers.
 */
export interface BackupFacts {
  /** Latest finished migration, or null when this role cannot read the history. */
  migrationHead: string | null;
  migrations: number;
  orders: number;
  /** Sum of order totals in fils, as text (bigint). */
  ordersTotalFils: string;
  collectedOrders: number;
  variants: number;
  stockOnHand: number;
  stockMovements: number;
  /** Variants whose stock differs from the sum of their ledger movements. */
  ledgerMismatches: number;
  couponRedemptions: number;
  /** Effects not yet completed, by status (pending, running, failed, dead…). */
  unfinishedEffects: Record<string, number>;
  /** The newest committed business write the backup holds (orders, stock, outbox). */
  latestWriteAt: string | null;
  /** Media-bucket keys of processed images the store can show. */
  mediaKeys: string[];
}

/** Run inside the snapshot the dump uses, so the facts and the dump describe one moment. */
export async function backupFacts(db: DbExecutor): Promise<BackupFacts> {
  const [history] = await db.$queryRaw<Array<{ readable: boolean }>>(Prisma.sql`
    SELECT coalesce(to_regclass('_prisma_migrations') IS NOT NULL
      AND has_table_privilege(to_regclass('_prisma_migrations'), 'SELECT'), false) AS readable`);
  let migrationHead: string | null = null;
  let migrations = 0;
  if (history?.readable) {
    const rows = await db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT migration_name AS name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
    migrations = rows.length;
    migrationHead = rows.at(-1)?.name ?? null;
  }
  const [totals] = await db.$queryRaw<
    Array<{
      orders: number;
      total: string;
      collected: number;
      variants: number;
      onHand: number;
      movements: number;
      redemptions: number;
      latest: Date | null;
    }>
  >(Prisma.sql`
    SELECT
      (SELECT count(*)::int FROM orders) AS orders,
      (SELECT coalesce(sum(total_fils), 0)::text FROM orders) AS total,
      (SELECT count(*)::int FROM orders WHERE cod_status = 'collected') AS collected,
      (SELECT count(*)::int FROM variants) AS variants,
      (SELECT coalesce(sum(stock_on_hand), 0)::int FROM variants) AS "onHand",
      (SELECT count(*)::int FROM stock_movements) AS movements,
      (SELECT count(*)::int FROM coupon_redemptions) AS redemptions,
      greatest(
        (SELECT max(created_at) FROM orders),
        (SELECT max(created_at) FROM stock_movements),
        (SELECT max(created_at) FROM outbox_events)
      ) AS latest`);
  const effects = await db.$queryRaw<Array<{ status: string; n: number }>>(Prisma.sql`
    SELECT status, count(*)::int AS n FROM consumer_effects
    WHERE status <> 'completed' GROUP BY status ORDER BY status`);
  const media = await db.$queryRaw<Array<{ keys: unknown }>>(Prisma.sql`
    SELECT derivative_keys AS keys FROM media_assets WHERE state = 'ready'`);
  const mediaKeys = [
    ...new Set(
      media.flatMap((row) =>
        row.keys && typeof row.keys === "object"
          ? Object.values(row.keys as Record<string, unknown>).filter(
              (key): key is string => typeof key === "string",
            )
          : [],
      ),
    ),
  ].sort();
  return {
    migrationHead,
    migrations,
    orders: totals!.orders,
    ordersTotalFils: totals!.total,
    collectedOrders: totals!.collected,
    variants: totals!.variants,
    stockOnHand: totals!.onHand,
    stockMovements: totals!.movements,
    ledgerMismatches: (
      await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n FROM variants v
        WHERE v.stock_on_hand <> coalesce((SELECT sum(m.delta) FROM stock_movements m
          WHERE m.variant_id = v.id), 0)`)
    )[0]!.n,
    couponRedemptions: totals!.redemptions,
    unfinishedEffects: Object.fromEntries(effects.map((row) => [row.status, row.n])),
    latestWriteAt: totals!.latest ? totals!.latest.toISOString() : null,
    mediaKeys,
  };
}
