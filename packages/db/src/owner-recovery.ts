import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { normalizeEmail } from "@ih/domain";
import { PrismaAuditWriter } from "./audit";
import { Prisma, type Database } from "./client";
import { lockOwnerRole } from "./identity";
import { invalidateStaffCapabilities } from "./identity-transaction";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

export class OwnerRecoveryRefusedError extends Error {
  constructor(
    readonly code: "OWNER_RECOVERY_NOT_OWNER" | "OWNER_RECOVERY_ACTIVE_OWNER",
    message: string,
  ) {
    super(message);
  }
}

export interface OwnerRecoveryResult {
  readonly id: string;
  readonly reactivated: boolean;
  readonly sessionsRevoked: number;
  /** Other active Owners at recovery time (they may be the compromised party; check them). */
  readonly otherActiveOwners: number;
}

/**
 * Break-glass Owner recovery (roadmap step 127, ADR 0099) for when no Owner can sign in or
 * receive a reset email. It only restores an account that already holds the Owner role: the role
 * and its grants never change, and no account is created. Under the common Owner lock it sets
 * the new argon2id hash, reactivates the account, bumps its version (outstanding links die),
 * revokes every session, reset link and pending invitation of it, and writes the audit entry and
 * events in the same transaction. Refused while another Owner is active unless the operator says
 * that Owner is not trusted (`despiteActiveOwner`).
 */
export async function recoverOwnerAccess(
  db: Database,
  context: CommandContext,
  input: { email: string; passwordHash: string; reason: string; despiteActiveOwner?: boolean },
): Promise<OwnerRecoveryResult> {
  const email = normalizeEmail(input.email);
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500)
    throw new RangeError("Recovery needs a reason (8–500)");
  if (!input.passwordHash.startsWith("$argon2id$")) throw new Error("Expected an argon2id hash");
  const audit = new PrismaAuditWriter();
  const outbox = new PrismaOutboxWriter();
  return withTransaction(db, async (tx) => {
    const ownerRoleId = await lockOwnerRole(tx);
    const rows = await tx.$queryRaw<
      Array<{ id: string; role_id: string; active: boolean; version: number }>
    >(Prisma.sql`
      SELECT id, role_id, active, version FROM staff_users WHERE email = ${email} FOR UPDATE`);
    const target = rows[0];
    if (!target || target.role_id !== ownerRoleId)
      throw new OwnerRecoveryRefusedError(
        "OWNER_RECOVERY_NOT_OWNER",
        "Only an existing Owner account can be recovered",
      );
    const otherActiveOwners = await tx.staffUser.count({
      where: { active: true, roleId: ownerRoleId, id: { not: target.id } },
    });
    if (otherActiveOwners > 0 && !input.despiteActiveOwner)
      throw new OwnerRecoveryRefusedError(
        "OWNER_RECOVERY_ACTIVE_OWNER",
        "Another Owner is active: use the admin, or confirm that Owner is not trusted",
      );
    const version = target.version + 1;
    await tx.$executeRaw(Prisma.sql`
      UPDATE staff_users SET password_hash = ${input.passwordHash}, active = true,
        version = ${version}, updated_at = statement_timestamp()
      WHERE id = ${target.id}::uuid`);
    // Revoked here for the count; the shared helper then finds none left and voids links/invites.
    const sessionsRevoked = await tx.$executeRaw(Prisma.sql`
      UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = 'owner_recovered'
      WHERE user_id = ${target.id}::uuid AND revoked_at IS NULL`);
    await invalidateStaffCapabilities(tx, context, target.id, "owner_recovered");
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.owner_recovered",
        entity: { type: "staff_user", id: target.id },
        before: { active: target.active, version: target.version, passwordHash: "previous" },
        after: { active: true, version, passwordHash: "changed", sessionsRevoked },
        reason,
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.password_reset", target.id, { userId: target.id }, version),
    );
    if (!target.active)
      await outbox.publish(
        tx,
        defineEvent("staff.reactivated", target.id, { userId: target.id }, version),
      );
    return { id: target.id, reactivated: !target.active, sessionsRevoked, otherActiveOwners };
  });
}
