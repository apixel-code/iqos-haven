import {
  couponDiscount,
  couponRejection,
  normalizeCouponCode,
  type CouponRejection,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { enterLockGroup, hasReachedLockGroup, isUnitOfWork } from "./transaction";

/**
 * The coupon cannot be used. Carries no code and no customer data. A store route answers with
 * `code` only: `reason` would tell a guesser whether a code exists, so it stays in the server.
 */
export class CouponRejectedError extends Error {
  /** Store API code (architecture §7): a full coupon is told apart, the rest are "invalid". */
  readonly code: "COUPON_INVALID" | "COUPON_LIMIT_REACHED";
  constructor(readonly reason: CouponRejection) {
    super("Coupon rejected");
    this.code = reason === "LIMIT_REACHED" ? "COUPON_LIMIT_REACHED" : "COUPON_INVALID";
  }
}
export interface AppliedCoupon {
  couponId: string;
  code: string;
  percentBps: number;
  /** Version the terms were read at; part of the quote fingerprint (step 71). */
  version: number;
  /** The server-computed subtotal the coupon was judged on. */
  merchandiseSubtotalFils: number;
  /** Half-up percentage of that subtotal. A tiny order can earn 0 and still counts as a use. */
  discountFils: number;
}
/** Coupons locked in each open unit of work: only those can be redeemed in it. */
const lockedCoupons = new WeakMap<object, WeakSet<AppliedCoupon>>();
interface CouponRow {
  id: string;
  code: string;
  percentBps: number;
  minSubtotalFils: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
  usageLimit: number | null;
  activeRedemptions: number;
  version: number;
  now: Date;
}
async function evaluate(
  db: Database | Tx,
  typedCode: string,
  merchandiseSubtotalFils: number,
  lock: boolean,
): Promise<AppliedCoupon> {
  // A code that cannot exist is answered like one that does not: no hint about the format.
  let code: string;
  try {
    code = normalizeCouponCode(typedCode);
  } catch {
    throw new CouponRejectedError("UNKNOWN");
  }
  // The clock is the database's, read in the same statement as the row.
  const [row] = await db.$queryRaw<CouponRow[]>(Prisma.sql`
    SELECT id, code, percent_bps AS "percentBps", min_subtotal_fils::int AS "minSubtotalFils",
      starts_at AS "startsAt", expires_at AS "expiresAt", active, usage_limit AS "usageLimit",
      active_redemptions AS "activeRedemptions", version, statement_timestamp() AS now
    FROM coupons WHERE code=${code} ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  const reason = couponRejection(row ?? null, row?.now ?? new Date(0), merchandiseSubtotalFils);
  if (reason || !row) throw new CouponRejectedError(reason ?? "UNKNOWN");
  return {
    couponId: row.id,
    code: row.code,
    percentBps: row.percentBps,
    version: row.version,
    merchandiseSubtotalFils,
    discountFils: couponDiscount(merchandiseSubtotalFils, row.percentBps),
  };
}
/**
 * Whether one typed code can be used on this merchandise subtotal right now, and the discount
 * it gives. No lock and no use recorded: for a quote preview. The subtotal must come from
 * `readOrderPrices`, never from the client.
 */
export async function previewCoupon(
  db: Database | Tx,
  code: string,
  merchandiseSubtotalFils: number,
): Promise<AppliedCoupon> {
  return evaluate(db, code, merchandiseSubtotalFils, false);
}
/**
 * Coupon group of the resource order (after catalogue prices, before variants). Locks the
 * coupon row FOR UPDATE until commit and decides eligibility under that lock, so two orders
 * cannot both take the last use and an Owner edit cannot change the terms mid-order.
 */
export async function lockCouponForOrder(
  tx: Tx,
  code: string,
  merchandiseSubtotalFils: number,
): Promise<AppliedCoupon> {
  if (!isUnitOfWork(tx)) throw new Error("Locking a coupon requires a unit of work");
  enterLockGroup(tx, "coupon");
  const applied = await evaluate(tx, code, merchandiseSubtotalFils, true);
  const held = lockedCoupons.get(tx) ?? new WeakSet<AppliedCoupon>();
  lockedCoupons.set(tx, held);
  held.add(applied);
  return applied;
}
/**
 * Records the order's use of a coupon. Accepts only the very object `lockCouponForOrder`
 * returned in this transaction, so the terms, subtotal and discount written are the ones
 * decided under the lock. The use count is raised by the database from this insert. An order
 * has at most one active redemption; editable orders retain released rows as history. The owning
 * order command writes the audit entry and events; nothing else may call this.
 */
export async function redeemCoupon(tx: Tx, orderId: string, coupon: AppliedCoupon) {
  if (!isUnitOfWork(tx)) throw new Error("Redeeming a coupon requires a unit of work");
  if (!lockedCoupons.get(tx)?.has(coupon))
    throw new Error("Redeem only a coupon locked in this unit of work");
  return tx.couponRedemption.create({
    data: {
      couponId: coupon.couponId,
      orderId,
      code: coupon.code,
      percentBps: coupon.percentBps,
      merchandiseSubtotalFils: BigInt(coupon.merchandiseSubtotalFils),
      discountFils: BigInt(coupon.discountFils),
    },
  });
}

/** Replaces/removes an editable order's active coupon under sorted coupon locks. */
export async function replaceCouponForOrder(
  tx: Tx,
  orderId: string,
  code: string | null,
  merchandiseSubtotalFils: number,
): Promise<AppliedCoupon | null> {
  if (!isUnitOfWork(tx) || !hasReachedLockGroup(tx, "order"))
    throw new Error("Replacing a coupon requires the locked order unit of work");
  const [current] = await tx.$queryRaw<Array<{ couponId: string }>>(Prisma.sql`
    SELECT coupon_id AS "couponId" FROM coupon_redemptions
    WHERE order_id=${orderId}::uuid AND released_at IS NULL`);
  let normalized: string | null = null;
  let nextId: string | null = null;
  if (code !== null) {
    try {
      normalized = normalizeCouponCode(code);
    } catch {
      throw new CouponRejectedError("UNKNOWN");
    }
    const [next] = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM coupons WHERE code=${normalized}`,
    );
    if (!next) throw new CouponRejectedError("UNKNOWN");
    nextId = next.id;
  }
  const ids = [...new Set([current?.couponId, nextId].filter((id): id is string => !!id))].sort();
  if (ids.length) {
    enterLockGroup(tx, "coupon");
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM coupons WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`,
    );
  }
  if (current)
    await tx.$executeRaw(
      Prisma.sql`UPDATE coupon_redemptions SET released_at=statement_timestamp()
        WHERE order_id=${orderId}::uuid AND released_at IS NULL`,
    );
  if (normalized === null) return null;
  const applied = await evaluate(tx, normalized, merchandiseSubtotalFils, false);
  const held = lockedCoupons.get(tx) ?? new WeakSet<AppliedCoupon>();
  lockedCoupons.set(tx, held);
  held.add(applied);
  return applied;
}
/**
 * Gives the use back when an order is cancelled before delivery. The caller holds the order
 * lock; this takes the coupon lock next, as the resource order requires. Returns true the one
 * time it releases; a repeat, or an order without a coupon, returns false and changes nothing.
 */
export async function releaseCouponRedemption(tx: Tx, orderId: string): Promise<boolean> {
  if (!isUnitOfWork(tx)) throw new Error("Releasing a coupon requires a unit of work");
  // A release belongs to a command on that order: the order row is locked first (`lockOrder`).
  if (!hasReachedLockGroup(tx, "order"))
    throw new Error("Release a coupon only after locking its order in this unit of work");
  const [redemption] = await tx.$queryRaw<Array<{ couponId: string }>>(
    Prisma.sql`SELECT coupon_id AS "couponId" FROM coupon_redemptions WHERE order_id=${orderId}::uuid AND released_at IS NULL`,
  );
  if (!redemption) return false;
  enterLockGroup(tx, "coupon");
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM coupons WHERE id=${redemption.couponId}::uuid FOR UPDATE`,
  );
  return (
    (await tx.$executeRaw(
      Prisma.sql`UPDATE coupon_redemptions SET released_at=statement_timestamp() WHERE order_id=${orderId}::uuid AND released_at IS NULL`,
    )) === 1
  );
}
/** Use counts that disagree with the redemption rows; always empty unless something is broken. */
export async function couponCountMismatches(db: Database | Tx) {
  return db.$queryRaw<Array<{ id: string; counted: number; stored: number }>>(Prisma.sql`
    SELECT c.id, c.active_redemptions AS stored,
      (SELECT count(*)::int FROM coupon_redemptions r
        WHERE r.coupon_id=c.id AND r.released_at IS NULL) AS counted
    FROM coupons c
    WHERE c.active_redemptions <> (SELECT count(*) FROM coupon_redemptions r
      WHERE r.coupon_id=c.id AND r.released_at IS NULL)`);
}
