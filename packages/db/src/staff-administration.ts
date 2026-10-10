import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { normalizeEmail, normalizeStaffName, type RoleKey } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction, sortedForLocking } from "./transaction";
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
const select = {
  id: true,
  email: true,
  name: true,
  active: true,
  version: true,
  createdAt: true,
  lastActiveAt: true,
  role: { select: { key: true } },
} as const;
function response(row: {
  id: string;
  email: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: Date;
  lastActiveAt: Date | null;
  role: { key: string };
}) {
  return {
    ...row,
    role: row.role.key as RoleKey,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  };
}
async function hasAuthority(tx: Tx | Database, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >(Prisma.sql`SELECT u.id FROM staff_users u WHERE u.id = ${id}::uuid AND u.active
    AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.key = 'staff.manage')`);
  return !!rows[0];
}
export async function listStaff(
  db: Database,
  actorId: string,
  query: { limit: number; after?: string | undefined },
) {
  if (!(await hasAuthority(db, actorId))) throw new StaffForbiddenError();
  const rows = await db.staffUser.findMany({
    select,
    orderBy: { id: "asc" },
    take: query.limit + 1,
    ...(query.after ? { where: { id: { gt: query.after } } } : {}),
  });
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  return { items: page.map(response), nextCursor: more ? page.at(-1)!.id : null };
}
async function lockStaff(tx: Tx, context: CommandContext, targetId: string) {
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
async function invalidate(
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
export async function editStaff(
  db: Database,
  context: CommandContext,
  id: string,
  input: { version: number; name?: string | undefined; email?: string | undefined },
) {
  const name = input.name === undefined ? undefined : normalizeStaffName(input.name);
  const email = input.email === undefined ? undefined : normalizeEmail(input.email);
  try {
    return await withTransaction(db, async (tx) => {
      const { target } = await lockStaff(tx, context, id);
      if (target.version !== input.version) throw new StaffConflictError();
      if (
        (name === undefined || name === target.name) &&
        (email === undefined || email === target.email)
      )
        return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
      const nextName = name ?? target.name;
      const nextEmail = email ?? target.email;
      await tx.$executeRaw(
        Prisma.sql`UPDATE staff_users SET name = ${nextName}, email = ${nextEmail}, version = version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid`,
      );
      if (nextEmail !== target.email) await invalidate(tx, context, id, "admin_revoked");
      await audit.append(
        tx,
        toAuditEntry(context, {
          action: "staff.updated",
          entity: { type: "staff_user", id },
          before: { name: target.name, email: target.email, version: target.version },
          after: { name: nextName, email: nextEmail, version: target.version + 1 },
        }),
      );
      await outbox.publish(
        tx,
        defineEvent("staff.updated", id, { userId: id }, target.version + 1),
      );
      return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "P2002") throw new StaffConflictError();
    // Raw UPDATE uniqueness errors are exposed by Prisma as P2010 / PostgreSQL 23505.
    if (
      (
        error as {
          code?: unknown;
          meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
        }
      ).code === "P2010"
    ) {
      const meta = (
        error as {
          meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
        }
      ).meta;
      if (meta?.code === "23505" || meta?.driverAdapterError?.cause?.originalCode === "23505")
        throw new StaffConflictError();
    }
    throw error;
  }
}
export async function deactivateStaff(
  db: Database,
  context: CommandContext,
  id: string,
  version: number,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const { target, ownerRoleId } = await lockStaff(tx, context, id);
    if (target.version !== version) throw new StaffConflictError();
    if (!target.active) return;
    if (
      target.roleId === ownerRoleId &&
      (await tx.staffUser.count({ where: { active: true, roleId: ownerRoleId } })) <= 1
    )
      throw new LastOwnerError();
    await tx.$executeRaw(
      Prisma.sql`UPDATE staff_users SET active = false, version = version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid`,
    );
    await invalidate(tx, context, id, "deactivated");
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.deactivated",
        entity: { type: "staff_user", id },
        before: { active: true, version: target.version },
        after: { active: false, version: target.version + 1 },
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.deactivated", id, { userId: id }, target.version + 1),
    );
  });
}
