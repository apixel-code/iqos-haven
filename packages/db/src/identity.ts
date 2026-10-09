import { toAuditEntry, type CommandContext } from "@ih/application";
import { normalizeEmail, normalizeStaffName } from "@ih/domain";
import { PrismaAuditWriter } from "./audit";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";

export class OwnerAlreadyExistsError extends Error {
  readonly code = "OWNER_ALREADY_EXISTS";
}
export class StaffEmailTakenError extends Error {
  readonly code = "STAFF_EMAIL_TAKEN";
}

/**
 * Common identity guard (architecture §11): every Owner membership/activation change first
 * locks the seeded owner role row, so concurrent changes are serialized. Returns its id.
 */
export async function lockOwnerRole(tx: Tx): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM roles WHERE key = 'owner' FOR UPDATE`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Owner role seed missing");
  return id;
}

/** Cheap read-only pre-check (the CLI asks before prompting); the transaction re-checks. */
export async function ownerExists(db: Database): Promise<boolean> {
  return (await db.staffUser.count({ where: { role: { key: "owner" } } })) > 0;
}

/**
 * One-time creation of the first Owner (roadmap step 28). Allowed only while no Owner account
 * exists at all — active or deactivated — so re-running can never mint an extra Owner;
 * recovering an unavailable Owner is a separate audited operational process. The caller passes
 * an argon2id hash; this function never sees the password.
 */
export async function bootstrapFirstOwner(
  db: Database,
  context: CommandContext,
  input: { email: string; name: string; passwordHash: string },
): Promise<string> {
  const email = normalizeEmail(input.email);
  const name = normalizeStaffName(input.name);
  if (!input.passwordHash.startsWith("$argon2id$")) throw new Error("Expected an argon2id hash");
  const audit = new PrismaAuditWriter();
  return withTransaction(db, async (tx) => {
    const ownerRoleId = await lockOwnerRole(tx);
    if ((await tx.staffUser.count({ where: { roleId: ownerRoleId } })) > 0)
      throw new OwnerAlreadyExistsError("An Owner account already exists");
    if (await tx.staffUser.findUnique({ where: { email }, select: { id: true } }))
      throw new StaffEmailTakenError("Email already belongs to a staff account");
    let owner: { id: string };
    try {
      owner = await tx.staffUser.create({
        data: { email, name, passwordHash: input.passwordHash, roleId: ownerRoleId },
        select: { id: true },
      });
    } catch (error) {
      // A concurrent non-Owner insert of the same email wins the unique index.
      if ((error as { code?: unknown }).code === "P2002")
        throw new StaffEmailTakenError("Email already belongs to a staff account");
      throw error;
    }
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "staff.owner_bootstrapped",
        entity: { type: "staff_user", id: owner.id },
        after: { email, name, role: "owner", active: true },
        reason: "first Owner bootstrap",
      }),
    );
    return owner.id;
  });
}
