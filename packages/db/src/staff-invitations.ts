import { toAuditEntry, type CommandContext } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import { normalizeEmail, normalizeStaffName, type RoleKey } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { lockOwnerRole } from "./identity";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

export class InvitationNotAllowedError extends Error {
  readonly code = "INVITATION_NOT_ALLOWED";
}
export class InvitationAccountExistsError extends Error {
  readonly code = "INVITATION_ACCOUNT_EXISTS";
}
const audit = new PrismaAuditWriter();
const outbox = new PrismaOutboxWriter();
/** All commands: owner-role guard → inviting staff row → invitation row/new staff insert.
 * This serializes Owner membership and rechecks authority after the HTTP guard.
 */
async function lockInviter(tx: Tx, id: string): Promise<boolean> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM staff_users WHERE id = ${id}::uuid FOR UPDATE`);
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT u.id FROM staff_users u
    JOIN role_permissions rp ON rp.role_id = u.role_id JOIN permissions p ON p.id = rp.permission_id
    WHERE u.id = ${id}::uuid AND u.active AND p.key = 'staff.manage'`);
  return !!rows[0];
}
export async function issueStaffInvitation(
  db: Database,
  context: CommandContext,
  input: {
    id: string;
    email: string;
    name: string;
    role: RoleKey;
    tokenHash: Buffer;
    keyId: string;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const email = normalizeEmail(input.email);
  const name = normalizeStaffName(input.name);
  return withTransaction(db, async (tx) => {
    await lockOwnerRole(tx);
    if (!context.actorId || !(await lockInviter(tx, context.actorId)))
      throw new InvitationNotAllowedError();
    if (await tx.staffUser.findUnique({ where: { email } }))
      throw new InvitationAccountExistsError();
    const role = await tx.role.findUniqueOrThrow({ where: { key: input.role } });
    // Resend replaces the pending immutable snapshot, including expired rows held by the index.
    const previous = await tx.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`UPDATE staff_invitation_tokens
      SET revoked_at = statement_timestamp(), version = version + 1
      WHERE email = ${email} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`);
    for (const prior of previous) {
      await audit.append(
        tx,
        toAuditEntry(context, {
          action: "staff.invitation_revoked",
          entity: { type: "staff_invitation", id: prior.id },
          after: { revoked: true },
          reason: "replaced by new invitation",
        }),
      );
      await outbox.publish(
        tx,
        defineEvent("staff.invitation_revoked", prior.id, { invitationId: prior.id }),
      );
    }
    const rows = await tx.$queryRaw<
      Array<{ id: string; expiresAt: Date }>
    >(Prisma.sql`INSERT INTO staff_invitation_tokens
      (id, email, name, role_id, invited_by, token_hash, key_id, expires_at)
      VALUES (${input.id}::uuid, ${email}, ${name}, ${role.id}::uuid, ${context.actorId}::uuid,
        ${input.tokenHash}, ${input.keyId}, statement_timestamp() + interval '24 hours')
      RETURNING id, expires_at AS "expiresAt"`);
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.invited",
        entity: { type: "staff_invitation", id: input.id },
        after: { email, name, role: input.role },
      }),
    );
    await outbox.publish(tx, defineEvent("staff.invited", input.id, { invitationId: input.id }));
    return rows[0]!;
  });
}
export async function revokeStaffInvitation(
  db: Database,
  context: CommandContext,
  id: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockOwnerRole(tx);
    if (!context.actorId || !(await lockInviter(tx, context.actorId)))
      throw new InvitationNotAllowedError();
    const changed =
      await tx.$executeRaw(Prisma.sql`UPDATE staff_invitation_tokens SET revoked_at = statement_timestamp(), version = version + 1
      WHERE id = ${id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL`);
    if (!changed) return;
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.invitation_revoked",
        entity: { type: "staff_invitation", id },
        after: { revoked: true },
      }),
    );
    await outbox.publish(tx, defineEvent("staff.invitation_revoked", id, { invitationId: id }));
  });
}
export async function staffInvitationCandidate(db: Database, id: string, tokenHash: Buffer) {
  const rows = await db.$queryRaw<
    Array<{ email: string; name: string }>
  >(Prisma.sql`SELECT i.email, i.name FROM staff_invitation_tokens i
    JOIN staff_users u ON u.id = i.invited_by
    WHERE i.id = ${id}::uuid AND i.token_hash = ${tokenHash} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at > statement_timestamp() AND u.active
      AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.key = 'staff.manage')
      AND NOT EXISTS (SELECT 1 FROM staff_users target WHERE target.email = i.email)`);
  return rows[0] ?? null;
}
export async function acceptStaffInvitation(
  db: Database,
  requestId: string,
  input: {
    id: string;
    tokenHash: Buffer;
    passwordHash: string;
  },
): Promise<boolean> {
  try {
    return await withTransaction(db, async (tx) => {
      await lockOwnerRole(tx);
      const initial = await tx.staffInvitationToken.findUnique({ where: { id: input.id } });
      if (!initial || !(await lockInviter(tx, initial.invitedBy))) return false;
      const rows = await tx.$queryRaw<
        Array<{ email: string; name: string; roleId: string }>
      >(Prisma.sql`SELECT email, name, role_id AS "roleId"
        FROM staff_invitation_tokens WHERE id = ${input.id}::uuid AND token_hash = ${input.tokenHash}
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > statement_timestamp() FOR UPDATE`);
      const invite = rows[0];
      if (!invite || (await tx.staffUser.findUnique({ where: { email: invite.email } })))
        return false;
      const user = await tx.staffUser.create({
        data: {
          email: invite.email,
          name: invite.name,
          roleId: invite.roleId,
          passwordHash: input.passwordHash,
        },
      });
      await tx.$executeRaw(
        Prisma.sql`UPDATE staff_invitation_tokens SET accepted_at = statement_timestamp(), version = version + 1 WHERE id = ${input.id}::uuid`,
      );
      const context = { requestId, actorId: null };
      await audit.append(
        tx,
        toAuditEntry(context, {
          action: "staff.invitation_accepted",
          entity: { type: "staff_user", id: user.id },
          after: {
            email: user.email,
            name: user.name,
            roleId: user.roleId,
            active: true,
            passwordHash: user.passwordHash,
          },
        }),
      );
      await outbox.publish(
        tx,
        defineEvent("staff.invitation_accepted", user.id, { userId: user.id }, user.version),
      );
      return true;
    });
  } catch (error) {
    // A non-invitation account creation may win email uniqueness; never overwrite that account.
    if ((error as { code?: unknown }).code === "P2002") return false;
    throw error;
  }
}
export async function loadStaffInvitationEmail(db: Database, id: string) {
  const invite = await db.staffInvitationToken.findUnique({ where: { id } });
  if (!invite || !(await staffInvitationCandidate(db, id, Buffer.from(invite.tokenHash))))
    return null;
  return invite;
}

/** Pending invitations, newest first (parity G-A11): not accepted, not revoked; expired flagged. */
export async function listPendingStaffInvitations(db: Database) {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      email: string;
      name: string;
      role: RoleKey;
      invitedBy: string | null;
      createdAt: Date;
      expiresAt: Date;
      expired: boolean;
    }>
  >(Prisma.sql`SELECT t.id, t.email, t.name, r.key AS role, u.name AS "invitedBy",
      t.created_at AS "createdAt", t.expires_at AS "expiresAt",
      t.expires_at <= statement_timestamp() AS expired
    FROM staff_invitation_tokens t JOIN roles r ON r.id = t.role_id
    LEFT JOIN staff_users u ON u.id = t.invited_by
    WHERE t.accepted_at IS NULL AND t.revoked_at IS NULL
    ORDER BY t.created_at DESC, t.id DESC LIMIT 100`);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}
