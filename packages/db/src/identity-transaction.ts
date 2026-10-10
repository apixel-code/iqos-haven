import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { Prisma, type Database, type Tx } from "./client";
import { sortedForLocking } from "./transaction";
import { lockOwnerRole } from "./identity";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
export class StaffForbiddenError extends Error {
  readonly code = "STAFF_FORBIDDEN";
}
export class StaffNotFoundError extends Error {
  readonly code = "STAFF_NOT_FOUND";
}
export class StaffConflictError extends Error {
  readonly code = "STAFF_CONFLICT";
}
export class LastOwnerError extends Error {
  readonly code = "LAST_ACTIVE_OWNER";
}
const audit = new PrismaAuditWriter();
const outbox = new PrismaOutboxWriter();
export async function hasAuthority(tx: Tx | Database, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >(Prisma.sql`SELECT u.id FROM staff_users u WHERE u.id = ${id}::uuid AND u.active
    AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.key = 'staff.manage')`);
  return !!rows[0];
}
export async function lockStaff(tx: Tx, context: CommandContext, targetId: string) {
  const ownerRoleId = await lockOwnerRole(tx);
  if (!context.actorId) throw new StaffForbiddenError();
  for (const id of sortedForLocking([context.actorId, targetId]))
    await tx.$queryRaw(Prisma.sql`SELECT id FROM staff_users WHERE id = ${id}::uuid FOR UPDATE`);
  if (!(await hasAuthority(tx, context.actorId))) throw new StaffForbiddenError();
  const target = await tx.staffUser.findUnique({
    where: { id: targetId },
    include: { role: true },
  });
  if (!target) throw new StaffNotFoundError();
  return { target, ownerRoleId };
}
/** Security edits invalidate sessions and durable capabilities under the already-held user lock. */
export async function invalidateStaffCapabilities(
  tx: Tx,
  context: CommandContext,
  id: string,
  reason: "deactivated" | "admin_revoked",
) {
  await tx.$executeRaw(
    Prisma.sql`UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = ${reason} WHERE user_id = ${id}::uuid AND revoked_at IS NULL`,
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE password_reset_tokens SET used_at = statement_timestamp() WHERE user_id = ${id}::uuid AND used_at IS NULL`,
  );
  const invites = await tx.$queryRaw<
    Array<{ id: string }>
  >(Prisma.sql`UPDATE staff_invitation_tokens SET revoked_at = statement_timestamp(), version = version + 1
    WHERE invited_by = ${id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`);
  for (const invite of invites) {
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.invitation_revoked",
        entity: { type: "staff_invitation", id: invite.id },
        after: { revoked: true },
        reason: "inviting account security change",
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.invitation_revoked", invite.id, { invitationId: invite.id }),
    );
  }
}

/** Called after the common Owner lock and affected users are held, before membership writes. */
export async function preserveActiveOwner(
  tx: Tx,
  target: { active: boolean; roleId: string },
  ownerRoleId: string,
  next: { active: boolean; roleId: string },
): Promise<void> {
  if (
    target.active &&
    target.roleId === ownerRoleId &&
    (!next.active || next.roleId !== ownerRoleId) &&
    (await tx.staffUser.count({ where: { active: true, roleId: ownerRoleId } })) <= 1
  )
    throw new LastOwnerError();
}
