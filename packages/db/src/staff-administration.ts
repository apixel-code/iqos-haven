import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { normalizeEmail, normalizeStaffName, type RoleKey } from "@ih/domain";
import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";
import {
  hasAuthority,
  lockStaff,
  preserveActiveOwner,
  invalidateStaffCapabilities,
  StaffForbiddenError,
  StaffConflictError,
} from "./identity-transaction";
export {
  StaffForbiddenError,
  StaffNotFoundError,
  StaffConflictError,
  LastOwnerError,
} from "./identity-transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
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
      if (nextEmail !== target.email)
        await invalidateStaffCapabilities(tx, context, id, "admin_revoked");
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
    await preserveActiveOwner(tx, target, ownerRoleId, { active: false, roleId: target.roleId });
    await tx.$executeRaw(
      Prisma.sql`UPDATE staff_users SET active = false, version = version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid`,
    );
    await invalidateStaffCapabilities(tx, context, id, "deactivated");
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

/** Fixed launch roles only; grants are immutable seeds, never caller-supplied permissions. */
export async function changeStaffRole(
  db: Database,
  context: CommandContext,
  id: string,
  input: { version: number; role: RoleKey },
) {
  return withTransaction(db, async (tx) => {
    const { target, ownerRoleId } = await lockStaff(tx, context, id);
    if (target.version !== input.version) throw new StaffConflictError();
    if (input.role !== "owner" && input.role !== "staff")
      throw new RangeError("Invalid fixed role");
    const role = await tx.role.findUniqueOrThrow({ where: { key: input.role } });
    if (target.roleId === role.id)
      return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
    await preserveActiveOwner(tx, target, ownerRoleId, { active: target.active, roleId: role.id });
    await tx.$executeRaw(
      Prisma.sql`UPDATE staff_users SET role_id = ${role.id}::uuid, version = version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid`,
    );
    await invalidateStaffCapabilities(tx, context, id, "admin_revoked");
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.role_changed",
        entity: { type: "staff_user", id },
        before: { role: target.role.key, version: target.version },
        after: { role: input.role, version: target.version + 1 },
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.role_changed", id, { userId: id }, target.version + 1),
    );
    return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
  });
}
export async function reactivateStaff(
  db: Database,
  context: CommandContext,
  id: string,
  version: number,
) {
  return withTransaction(db, async (tx) => {
    const { target } = await lockStaff(tx, context, id);
    if (target.version !== version) throw new StaffConflictError();
    if (target.active)
      return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
    await tx.$executeRaw(
      Prisma.sql`UPDATE staff_users SET active = true, version = version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid`,
    );
    await invalidateStaffCapabilities(tx, context, id, "admin_revoked");
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.reactivated",
        entity: { type: "staff_user", id },
        before: { active: false, version: target.version },
        after: { active: true, version: target.version + 1 },
      }),
    );
    await outbox.publish(
      tx,
      defineEvent("staff.reactivated", id, { userId: id }, target.version + 1),
    );
    return response(await tx.staffUser.findUniqueOrThrow({ where: { id }, select }));
  });
}
