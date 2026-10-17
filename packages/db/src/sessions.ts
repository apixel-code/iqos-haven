import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type RoleKey,
  type SessionRevokeReason,
} from "@ih/domain";
import { Prisma, type Database, type DbExecutor } from "./client";
import { withTransaction } from "./transaction";

/**
 * Admin session persistence (architecture §11). Only the SHA-256 of the token is stored. Every
 * time comparison uses the database clock, and validity (revocation, idle, absolute expiry,
 * active user) is decided in one query so no code path can skip a check.
 */

export interface LoginCandidate {
  readonly id: string;
  readonly passwordHash: string;
  readonly active: boolean;
  readonly version: number;
}

export async function findLoginCandidate(
  db: DbExecutor,
  email: string,
): Promise<LoginCandidate | null> {
  return db.staffUser.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, active: true, version: true },
  });
}

/**
 * Upgrades a stored hash after a successful login (needsRehash); never bumps `version`.
 * Conditional on the old hash so a concurrent password reset is never overwritten.
 * Returns whether the upgrade happened.
 */
export async function upgradePasswordHash(
  db: DbExecutor,
  userId: string,
  oldHash: string,
  newHash: string,
): Promise<boolean> {
  const { count } = await db.staffUser.updateMany({
    where: { id: userId, passwordHash: oldHash },
    data: { passwordHash: newHash },
  });
  return count === 1;
}

/**
 * Creates a session only if the user is still active and still has the password hash that was
 * just verified and the same identity version, so reset/deactivation/email edits cannot be outrun.
 * Returns null when that is no longer true.
 */
export async function createSession(
  db: Database,
  input: {
    userId: string;
    /** The hash the caller verified against (or the one it just upgraded to). */
    expectedPasswordHash: string;
    expectedUserVersion: number;
    tokenHash: Buffer;
    ipNetwork: string | null;
    clientLabel: string | null;
  },
): Promise<{ id: string; expiresAt: Date } | null> {
  return withTransaction(db, async (tx) => {
    // Serialize with password reset. INSERT SELECT alone may read an old MVCC snapshot before
    // its FK lock waits, letting an uncommitted old-password session escape reset revocation.
    const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM staff_users WHERE id = ${input.userId}::uuid
      AND active AND password_hash = ${input.expectedPasswordHash} AND version = ${input.expectedUserVersion} FOR UPDATE`);
    if (!users[0]) return null;
    const rows = await tx.$queryRaw<Array<{ id: string; expires_at: Date }>>(Prisma.sql`
    INSERT INTO sessions (user_id, token_hash, expires_at, ip_network, client_label)
    SELECT u.id, ${input.tokenHash},
           statement_timestamp() + make_interval(secs => ${SESSION_ABSOLUTE_MS / 1000}),
           ${input.ipNetwork}, ${input.clientLabel}
    FROM staff_users u
    WHERE u.id = ${input.userId}::uuid AND u.active AND u.password_hash = ${input.expectedPasswordHash}
    RETURNING id, expires_at`);
    const row = rows[0];
    if (!row) return null;
    await tx.$executeRaw(Prisma.sql`
    UPDATE staff_users SET last_active_at = statement_timestamp() WHERE id = ${input.userId}::uuid`);
    return { id: row.id, expiresAt: row.expires_at };
  });
}

export interface AuthenticatedStaff {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: RoleKey;
  readonly permissions: readonly string[];
}

/**
 * Resolves a token hash to an authenticated staff member, or null when the session is unknown,
 * revoked, past its absolute expiry, idle for longer than the idle timeout, or the user is
 * inactive. Refreshes last-seen at most every SESSION_TOUCH_INTERVAL_MS (never extends the
 * absolute expiry).
 */
export async function authenticateSession(
  db: Database,
  tokenHash: Buffer,
): Promise<AuthenticatedStaff | null> {
  const rows = await db.$queryRaw<
    Array<{
      session_id: string;
      expires_at: Date;
      user_id: string;
      email: string;
      name: string;
      role: RoleKey;
      permissions: string[] | null;
      touch: boolean;
    }>
  >(Prisma.sql`
    SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.name, r.key AS role,
           array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL) AS permissions,
           s.last_seen_at < statement_timestamp() - make_interval(secs => ${SESSION_TOUCH_INTERVAL_MS / 1000}) AS touch
    FROM sessions s
    JOIN staff_users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE s.token_hash = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > statement_timestamp()
      AND s.last_seen_at > statement_timestamp() - make_interval(secs => ${SESSION_IDLE_MS / 1000})
      AND u.active
    GROUP BY s.id, u.id, r.key`);
  const row = rows[0];
  if (!row) return null;
  if (row.touch)
    await db.$executeRaw(Prisma.sql`
      UPDATE sessions SET last_seen_at = statement_timestamp()
      WHERE id = ${row.session_id}::uuid AND revoked_at IS NULL
        AND last_seen_at < statement_timestamp() - make_interval(secs => ${SESSION_TOUCH_INTERVAL_MS / 1000})`);
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: row.permissions ?? [],
  };
}

/**
 * Whether a session is still good, without refreshing it: for a long-lived event stream that
 * must end when the session is revoked, expires, goes idle or its user is deactivated, but must
 * not itself keep the session alive.
 */
export async function sessionStillValid(db: Database, sessionId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>(Prisma.sql`
    SELECT 1 AS ok FROM sessions s JOIN staff_users u ON u.id=s.user_id
    WHERE s.id=${sessionId}::uuid AND s.revoked_at IS NULL
      AND s.expires_at > statement_timestamp()
      AND s.last_seen_at > statement_timestamp() - make_interval(secs => ${SESSION_IDLE_MS / 1000})
      AND u.active`);
  return rows.length === 1;
}

export async function revokeSession(
  db: DbExecutor,
  sessionId: string,
  reason: SessionRevokeReason,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = ${reason}
    WHERE id = ${sessionId}::uuid AND revoked_at IS NULL`);
}

/** Password reset, deactivation and role changes revoke every live session of the user. */
export async function revokeUserSessions(
  db: DbExecutor,
  userId: string,
  reason: SessionRevokeReason,
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = ${reason}
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`);
}

/** Logout: revokes whatever session this token names (even an expired one). Idempotent. */
export async function revokeSessionByTokenHash(db: DbExecutor, tokenHash: Buffer): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = 'logout'
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL`);
}
