import {
  couponCreateRequestSchema,
  couponResponseSchema,
  couponsQuerySchema,
  couponStateRequestSchema,
  couponUpdateRequestSchema,
  defineEvent,
  type ConflictCode,
  type CouponCreateRequest,
  type CouponResponse,
  type CouponsQuery,
  type CouponStateRequest,
  type CouponUpdateRequest,
} from "@ih/contracts";
import { couponStatus } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { lockOwnerRole } from "./identity";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

/**
 * Owner coupon administration (roadmap step 69, ADR 0039). Every change is one transaction:
 * actor share lock and permission, the coupon row FOR UPDATE, the version the Owner saw, the
 * write, one audit entry and one `coupon.updated` event. An order holding the coupon lock
 * makes an edit wait, and the other way round.
 */
export class CouponForbiddenError extends Error {}
export class CouponNotFoundError extends Error {}
export class CouponConflictError extends Error {
  constructor(readonly reason: ConflictCode) {
    super(reason);
  }
}
interface Row {
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
  deletedAt: Date | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  now: Date;
}
const COLUMNS = Prisma.sql`id, code, percent_bps AS "percentBps",
  min_subtotal_fils::int AS "minSubtotalFils", starts_at AS "startsAt", expires_at AS "expiresAt",
  active, usage_limit AS "usageLimit", active_redemptions AS "activeRedemptions", version,
  deleted_at AS "deletedAt", updated_by AS "updatedBy", created_at AS "createdAt",
  updated_at AS "updatedAt", statement_timestamp() AS now`;
const iso = (value: Date | null) => value?.toISOString() ?? null;
function response(row: Row): CouponResponse {
  return couponResponseSchema.parse({
    id: row.id,
    code: row.code,
    percentBps: row.percentBps,
    minSubtotalFils: row.minSubtotalFils,
    startsAt: iso(row.startsAt),
    expiresAt: iso(row.expiresAt),
    active: row.active,
    usageLimit: row.usageLimit,
    activeRedemptions: row.activeRedemptions,
    status: couponStatus(row, row.now, row.deletedAt !== null),
    version: row.version,
    trashedAt: iso(row.deletedAt),
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
/** What the audit trail keeps of a coupon: its terms, never who used it. */
const terms = (row: Row) => ({
  version: row.version,
  couponCode: row.code,
  percentBps: row.percentBps,
  minSubtotalFils: row.minSubtotalFils,
  startsAt: iso(row.startsAt),
  expiresAt: iso(row.expiresAt),
  active: row.active,
  usageLimit: row.usageLimit,
  trashed: row.deletedAt !== null,
});
async function authorized(tx: Database | Tx, actorId: string | null) {
  if (!actorId) throw new CouponForbiddenError();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT u.id FROM staff_users u WHERE u.id=${actorId}::uuid AND u.active AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=u.role_id AND p.key='coupons.manage')`,
  );
  if (!rows.length) throw new CouponForbiddenError();
}
async function authority(tx: Tx, context: CommandContext) {
  await lockOwnerRole(tx);
  if (!context.actorId) throw new CouponForbiddenError();
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM staff_users WHERE id=${context.actorId}::uuid FOR SHARE`,
  );
  await authorized(tx, context.actorId);
}
async function read(tx: Database | Tx, id: string, lock = false) {
  const [row] = await tx.$queryRaw<Row[]>(
    Prisma.sql`SELECT ${COLUMNS} FROM coupons WHERE id=${id}::uuid ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`,
  );
  return row ?? null;
}
async function record(
  tx: Tx,
  context: CommandContext,
  before: Row | null,
  after: Row,
  reason: string,
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: "coupon.updated",
      entity: { type: "coupon", id: after.id },
      before: before ? terms(before) : { version: 0 },
      after: terms(after),
      reason,
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("coupon.updated", after.id, { couponId: after.id }, after.version),
  );
}
function pgCode(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}
/**
 * Activating a coupon that has already ended, or moving an active coupon's end into the past,
 * would be confusing and useless. A coupon that simply ran out stays editable.
 */
function assertNotEnded(after: Row, before: Row | null) {
  const touched = !before || !before.active || iso(before.expiresAt) !== iso(after.expiresAt);
  if (
    touched &&
    after.active &&
    after.expiresAt &&
    after.expiresAt.getTime() <= after.now.getTime()
  )
    throw new CouponConflictError("ALREADY_EXPIRED");
}
export async function listCoupons(db: Database, actorId: string, input: CouponsQuery) {
  const query = couponsQuerySchema.parse(input);
  await authorized(db, actorId);
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM coupons
    WHERE (deleted_at IS NOT NULL) = ${query.trashed}
      ${query.after ? Prisma.sql`AND id < ${query.after}::uuid` : Prisma.empty}
    ORDER BY id DESC LIMIT ${query.limit + 1}`);
  const items = rows.slice(0, query.limit).map(response);
  return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
}
export async function createCoupon(
  db: Database,
  context: CommandContext,
  input: CouponCreateRequest,
) {
  const command = couponCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await authority(tx, context);
      const [created] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO coupons (code, percent_bps, min_subtotal_fils, starts_at, expires_at, active,
          usage_limit, updated_by)
        VALUES (${command.code}, ${command.percentBps}, ${command.minSubtotalFils},
          ${command.startsAt}::timestamptz, ${command.expiresAt}::timestamptz, ${command.active},
          ${command.usageLimit}::int, ${context.actorId}::uuid)
        RETURNING id`);
      const row = (await read(tx, created!.id))!;
      assertNotEnded(row, null);
      await record(tx, context, null, row, "coupon created");
      return response(row);
    });
  } catch (error) {
    // The code is unique for ever, including coupons in Trash.
    if (pgCode(error) === "23505") throw new CouponConflictError("DUPLICATE");
    throw error;
  }
}
/** Locks the coupon and checks it exists and is at the version the Owner saw. */
async function locked(tx: Tx, id: string, version: number) {
  const row = await read(tx, id, true);
  if (!row) throw new CouponNotFoundError();
  if (row.version !== version) throw new CouponConflictError("VERSION_CONFLICT");
  return row;
}
export async function updateCoupon(
  db: Database,
  context: CommandContext,
  id: string,
  input: CouponUpdateRequest,
) {
  const command = couponUpdateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await authority(tx, context);
    const before = await locked(tx, id, command.version);
    if (before.deletedAt) throw new CouponConflictError("TRASHED");
    // Orders already hold these uses; the limit cannot be set below them.
    if (command.usageLimit !== null && command.usageLimit < before.activeRedemptions)
      throw new CouponConflictError("LIMIT_BELOW_USES");
    const unchanged =
      before.percentBps === command.percentBps &&
      before.minSubtotalFils === command.minSubtotalFils &&
      iso(before.startsAt) === iso(command.startsAt ? new Date(command.startsAt) : null) &&
      iso(before.expiresAt) === iso(command.expiresAt ? new Date(command.expiresAt) : null) &&
      before.active === command.active &&
      before.usageLimit === command.usageLimit;
    if (unchanged) return response(before);
    await tx.$executeRaw(Prisma.sql`
      UPDATE coupons SET percent_bps=${command.percentBps},
        min_subtotal_fils=${command.minSubtotalFils}, starts_at=${command.startsAt}::timestamptz,
        expires_at=${command.expiresAt}::timestamptz, active=${command.active},
        usage_limit=${command.usageLimit}::int, version=version+1,
        updated_by=${context.actorId}::uuid, updated_at=statement_timestamp()
      WHERE id=${id}::uuid`);
    const after = (await read(tx, id))!;
    assertNotEnded(after, before);
    await record(tx, context, before, after, "coupon updated");
    return response(after);
  }).catch((error: unknown) => {
    // Unreachable while the check above holds the lock; kept so the table check never shows
    // as a server error.
    if (pgCode(error) === "23514") throw new CouponConflictError("LIMIT_BELOW_USES");
    throw error;
  });
}
async function setTrashed(
  db: Database,
  context: CommandContext,
  id: string,
  input: CouponStateRequest,
  trashed: boolean,
) {
  const command = couponStateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await authority(tx, context);
    const before = await locked(tx, id, command.version);
    if ((before.deletedAt !== null) === trashed)
      throw new CouponConflictError(trashed ? "TRASHED" : "NOT_TRASHED");
    // Trash deactivates; restore brings the coupon back inactive so nothing goes live by accident.
    await tx.$executeRaw(Prisma.sql`
      UPDATE coupons SET active=false,
        deleted_at=${trashed ? Prisma.sql`statement_timestamp()` : Prisma.sql`NULL`},
        version=version+1, updated_by=${context.actorId}::uuid, updated_at=statement_timestamp()
      WHERE id=${id}::uuid`);
    const after = (await read(tx, id))!;
    await record(tx, context, before, after, trashed ? "coupon trashed" : "coupon restored");
    return response(after);
  });
}
/** Moves a coupon to Trash. Orders that used it keep their redemption rows and discounts. */
export const trashCoupon = (
  db: Database,
  context: CommandContext,
  id: string,
  input: CouponStateRequest,
) => setTrashed(db, context, id, input, true);
export const restoreCoupon = (
  db: Database,
  context: CommandContext,
  id: string,
  input: CouponStateRequest,
) => setTrashed(db, context, id, input, false);
