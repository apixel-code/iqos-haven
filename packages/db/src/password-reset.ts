import { timingSafeEqual } from "node:crypto";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

const audit = new PrismaAuditWriter();
const outbox = new PrismaOutboxWriter();

/** Lock user first for every issue/consume; no hashing, SMTP or other network calls in the tx. */
export async function issuePasswordReset(
  db: Database,
  context: CommandContext,
  input: {
    email: string;
    id: string;
    tokenHash: Buffer;
    keyId: string;
    recipientHash: Buffer;
  },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const users = await tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`
      SELECT id, version FROM staff_users WHERE email = ${input.email} AND active FOR UPDATE`);
    const user = users[0];
    if (!user) return;
    await tx.$executeRaw(Prisma.sql`INSERT INTO password_reset_tokens
      (id, user_id, token_hash, key_id, user_version, recipient_hash, expires_at)
      VALUES (${input.id}::uuid, ${user.id}::uuid, ${input.tokenHash}, ${input.keyId},
        ${user.version}, ${input.recipientHash}, statement_timestamp() + interval '30 minutes')`);
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.password_reset_requested",
        entity: { type: "staff_user", id: user.id },
        after: { resetRequested: true },
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.password_reset_requested", user.id, { resetId: input.id }),
    );
  });
}

/** Read before expensive hashing. Consumption repeats every check under the user lock. */
export async function passwordResetCandidate(db: Database, id: string, tokenHash: Buffer) {
  const rows = await db.$queryRaw<
    Array<{ userId: string; email: string; name: string; userVersion: number }>
  >(Prisma.sql`
    SELECT u.id AS "userId", u.email, u.name, r.user_version AS "userVersion"
    FROM password_reset_tokens r JOIN staff_users u ON u.id = r.user_id
    WHERE r.id = ${id}::uuid AND r.token_hash = ${tokenHash} AND r.used_at IS NULL
      AND r.expires_at > statement_timestamp() AND u.active AND u.version = r.user_version`);
  return rows[0] ?? null;
}

export async function consumePasswordReset(
  db: Database,
  context: CommandContext,
  input: {
    id: string;
    tokenHash: Buffer;
    userId: string;
    userVersion: number;
    passwordHash: string;
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const users = await tx.$queryRaw<
      Array<{ id: string; active: boolean; version: number }>
    >(Prisma.sql`
      SELECT id, active, version FROM staff_users WHERE id = ${input.userId}::uuid FOR UPDATE`);
    const user = users[0];
    if (!user?.active || user.version !== input.userVersion) return false;
    const used = await tx.$executeRaw(Prisma.sql`UPDATE password_reset_tokens
      SET used_at = statement_timestamp() WHERE id = ${input.id}::uuid AND user_id = ${user.id}::uuid
      AND token_hash = ${input.tokenHash} AND used_at IS NULL
      AND expires_at > statement_timestamp() AND user_version = ${user.version}`);
    if (used !== 1) return false;
    await tx.staffUser.update({
      where: { id: user.id },
      data: {
        passwordHash: input.passwordHash,
        version: { increment: 1 },
      },
    });
    await tx.$executeRaw(Prisma.sql`UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = 'password_reset'
      WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL`);
    // Other outstanding links become invalid through version and used_at, under the same lock.
    await tx.$executeRaw(Prisma.sql`UPDATE password_reset_tokens SET used_at = statement_timestamp()
      WHERE user_id = ${user.id}::uuid AND used_at IS NULL`);
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.password_reset",
        entity: { type: "staff_user", id: user.id },
        before: { passwordHash: "previous" },
        after: { passwordHash: "changed", version: user.version + 1 },
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.password_reset", user.id, { userId: user.id }, user.version + 1),
    );
    return true;
  });
}

/** Planner access: never expose reset material through an API response. */
export async function loadPasswordResetEmail(db: Database, id: string) {
  const reset = await db.passwordResetToken.findUnique({ where: { id }, include: { user: true } });
  if (!reset || reset.usedAt || !reset.user.active || reset.user.version !== reset.userVersion)
    return null;
  const rows = await db.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT expires_at > statement_timestamp() AS valid FROM password_reset_tokens WHERE id = ${id}::uuid`);
  if (!rows[0]?.valid) return null;
  return reset;
}
export function sameResetHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
