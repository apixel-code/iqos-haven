import { createHash } from "node:crypto";
import { Prisma, type Database, type Tx } from "./client";
import { isUnitOfWork, withTransaction } from "./transaction";

/**
 * Idempotent commands (roadmap step 74, ADR 0043). A command that must happen at most once
 * (placing an order, cancelling one) names itself with a key. The key is claimed as the first
 * statement of the command's transaction, before any other lock:
 * - new key: the command runs and its answer is stored in the same transaction;
 * - same key, same payload: the stored answer is returned and nothing runs again;
 * - same key, different payload: refused;
 * - same key while the first attempt is still running: the caller waits a bounded time, then is
 *   told to retry.
 * A rolled-back attempt leaves no record, so the key can be used again after a correction.
 */
export class IdempotencyKeyError extends Error {}
/** The key was used for a different request. */
export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
}
/** Another attempt with this key has not finished. Retry the same key shortly. */
export class IdempotencyInProgressError extends Error {
  readonly code = "IDEMPOTENCY_IN_PROGRESS";
}
/** The key was accepted in the past but its answer is no longer kept. Never a new command. */
export class IdempotencyExpiredError extends Error {
  readonly code = "CHECKOUT_RECOVERY_REQUIRED";
  constructor(
    readonly resourceType: string | null,
    readonly resourceId: string | null,
  ) {
    super("Idempotency answer expired");
  }
}
const KEY = /^[A-Za-z0-9_-]{22,128}$/;
const SCOPE = /^[a-z][a-z0-9_.:-]{0,63}$/;
/**
 * Keys are made by the client: 22 to 128 URL-safe characters, meant to be random (a UUID or
 * more). Only the shape can be checked here, not the randomness, so a stored answer must never
 * hold anything that a guessed key should not reveal (see `completeIdempotency`).
 */
export function isIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}
/** What is stored and compared instead of the key. Bound to the scope. */
export function idempotencyKeyHash(scope: string, key: string): Buffer {
  if (!SCOPE.test(scope)) throw new IdempotencyKeyError("Invalid idempotency scope");
  if (!isIdempotencyKey(key)) throw new IdempotencyKeyError("Invalid idempotency key");
  return createHash("sha256").update(`ih:idempotency:v1:${scope}:${key}`).digest();
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new TypeError("Payload is nested too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    // A payload is hashed after validation: a float or NaN here is a programming error.
    if (!Number.isSafeInteger(value)) throw new TypeError("Payload numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) {
    // `Array.from` turns a hole into `undefined`, which is then refused like any non-JSON value.
    return `[${Array.from(value, (item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(",")}}`;
  throw new TypeError("Payload must be plain JSON");
}
/**
 * One hash for one request, whatever order its fields were written in. The caller passes the
 * normalized request (merged lines, normalized phone and address, coupon, accepted quote
 * fingerprint, confirmations), so two spellings of the same order are the same payload.
 */
export function canonicalPayloadHash(payload: unknown): Buffer {
  return createHash("sha256")
    .update("ih:payload:v1:" + canonical(payload))
    .digest();
}
export interface IdempotencyRequest {
  /** Endpoint namespace, plus the principal for staff commands: `store.checkout`, `admin.order.cancel:<staff id>`. */
  scope: string;
  key: string;
  payloadHash: Buffer;
  /** How long the answer can be replayed. At least 24 hours for checkout. */
  ttlSeconds?: number;
  /** How long to wait for another attempt with the same key before answering "in progress". */
  waitMs?: number;
}
export type IdempotencyClaim =
  | { kind: "claimed"; recordId: string }
  | {
      kind: "replay";
      response: Record<string, unknown>;
      resourceType: string | null;
      resourceId: string | null;
    };
const DAY = 24 * 60 * 60;
function pgCode(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}
/**
 * First statement of an idempotent command's transaction (the first group of the resource
 * order). Inserting the claim waits for a concurrent attempt with the same key instead of
 * failing the transaction, so no rollback is needed to read the winner.
 */
export async function claimIdempotency(
  tx: Tx,
  request: IdempotencyRequest,
): Promise<IdempotencyClaim> {
  if (!isUnitOfWork(tx)) throw new Error("An idempotency claim requires a unit of work");
  const keyHash = idempotencyKeyHash(request.scope, request.key);
  if (request.payloadHash.length !== 32) throw new IdempotencyKeyError("Invalid payload hash");
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
    Math.min(Math.max(Math.trunc(Number.isFinite(value) ? (value as number) : fallback), min), max);
  const ttl = bounded(request.ttlSeconds, DAY, 60, 30 * DAY);
  const wait = bounded(request.waitMs, 3000, 50, 30_000);
  let inserted: Array<{ id: string }>;
  try {
    // Bounds only this wait: the setting in force before is put back for the rest of the
    // command. Relies on Read Committed (`withTransaction`): the read below must see a winner
    // that committed while this insert waited.
    const [previous] = await tx.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`SELECT current_setting('lock_timeout') AS value`,
    );
    await tx.$queryRaw(Prisma.sql`SELECT set_config('lock_timeout', ${String(wait)}, true)`);
    inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO idempotency_records (scope, key_hash, payload_hash, expires_at)
      VALUES (${request.scope}, ${keyHash}, ${request.payloadHash},
        statement_timestamp() + make_interval(secs => ${ttl}))
      ON CONFLICT (scope, key_hash) DO NOTHING RETURNING id`);
    await tx.$queryRaw(
      Prisma.sql`SELECT set_config('lock_timeout', ${previous?.value ?? "0"}, true)`,
    );
  } catch (error) {
    if (pgCode(error) === "55P03") throw new IdempotencyInProgressError("Attempt in progress");
    throw error;
  }
  if (inserted[0]) return { kind: "claimed", recordId: inserted[0].id };
  const [winner] = await tx.$queryRaw<
    Array<{
      payloadHash: Buffer;
      response: Record<string, unknown> | null;
      resourceType: string | null;
      resourceId: string | null;
      expired: boolean;
    }>
  >(Prisma.sql`
    SELECT payload_hash AS "payloadHash", response, resource_type AS "resourceType",
      resource_id AS "resourceId", expires_at <= statement_timestamp() AS expired
    FROM idempotency_records WHERE scope=${request.scope} AND key_hash=${keyHash}`);
  // The other attempt rolled back between our insert and this read: ask the caller to retry.
  if (!winner || winner.response === null)
    throw new IdempotencyInProgressError("Attempt in progress");
  if (!Buffer.from(winner.payloadHash).equals(request.payloadHash))
    throw new IdempotencyConflictError("Key reused with a different payload");
  if (winner.expired) throw new IdempotencyExpiredError(winner.resourceType, winner.resourceId);
  return {
    kind: "replay",
    response: winner.response,
    resourceType: winner.resourceType,
    resourceId: winner.resourceId,
  };
}
/**
 * Stores the answer of a claimed command. Called once, before the transaction commits.
 * The answer is given again to anyone who presents the same key and payload, so it holds only
 * what the first response held and nothing more sensitive: no phone, name or address, no token,
 * cookie or capability, no link that grants access, and nothing that goes stale (a status).
 */
export async function completeIdempotency(
  tx: Tx,
  recordId: string,
  result: { response: Record<string, unknown>; resourceType?: string; resourceId?: string },
) {
  if (!isUnitOfWork(tx)) throw new Error("Completing a claim requires a unit of work");
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE idempotency_records SET response=${JSON.stringify(result.response)}::jsonb,
      resource_type=${result.resourceType ?? null}, resource_id=${result.resourceId ?? null}::uuid
    WHERE id=${recordId}::uuid AND response IS NULL`);
  if (updated !== 1) throw new Error("Idempotency claim is not open");
}
/**
 * Runs `work` at most once per key. The answer must be the sanitized response body and nothing
 * secret: it is stored and returned again on a retry. Everything `work` does is in the same
 * transaction as the claim. After a deadlock the whole transaction, `work` included, is run
 * again from the start, so `work` must change nothing outside the transaction.
 * A caller that keeps its own permanent record of the key (an order's `creation_key_hash`, made
 * with `idempotencyKeyHash` of the same scope) must look it up right after the claim: once an
 * expired record is cleaned up, this ledger alone no longer remembers the key.
 */
export async function runIdempotent<R extends Record<string, unknown>>(
  db: Database,
  request: IdempotencyRequest,
  work: (tx: Tx) => Promise<{ response: R; resourceType?: string; resourceId?: string }>,
): Promise<{ replayed: boolean; response: R; resourceId: string | null }> {
  return withTransaction(db, async (tx) => {
    const claim = await claimIdempotency(tx, request);
    if (claim.kind === "replay")
      return { replayed: true, response: claim.response as R, resourceId: claim.resourceId };
    const result = await work(tx);
    await completeIdempotency(tx, claim.recordId, result);
    return { replayed: false, response: result.response, resourceId: result.resourceId ?? null };
  });
}
/** Removes answers past their expiry, oldest first. The order keeps its own key hash for good. */
export async function deleteExpiredIdempotencyRecords(db: Database, limit = 1000) {
  const batch = Math.min(Math.max(Math.trunc(limit), 1), 5000);
  return db.$executeRaw(Prisma.sql`
    DELETE FROM idempotency_records WHERE id IN (
      SELECT id FROM idempotency_records WHERE expires_at <= statement_timestamp()
      ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)`);
}
