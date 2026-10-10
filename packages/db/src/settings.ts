import { isDeepStrictEqual } from "node:util";
import {
  settingsWriteRequestSchema,
  settingResponseSchema,
  settingKeySchema,
  defineEvent,
  type SettingsWriteRequest,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { lockOwnerRole } from "./identity";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
export class SettingsForbiddenError extends Error {}
export class SettingsConflictError extends Error {}
async function authorized(tx: Tx | Database, id: string | null) {
  if (!id) throw new SettingsForbiddenError();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT u.id FROM staff_users u WHERE u.id=${id}::uuid AND u.active AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=u.role_id AND p.key='settings.manage')`,
  );
  if (!rows.length) throw new SettingsForbiddenError();
}
function response(
  key: string,
  row?: { value: unknown; version: number; updatedAt: Date; updatedBy: string } | null,
) {
  return settingResponseSchema.parse({
    key,
    value: row?.value ?? null,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  });
}
export async function readSettings(db: Database, actorId: string) {
  await authorized(db, actorId);
  const rows = await db.setting.findMany();
  return {
    items: settingKeySchema.options.map((key) =>
      response(
        key,
        rows.find((row) => row.key === key),
      ),
    ),
  };
}
export async function writeSetting(
  db: Database,
  context: CommandContext,
  input: SettingsWriteRequest,
) {
  const command = settingsWriteRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    // Authority is stable until commit: all identity/security mutations take this same role guard.
    await lockOwnerRole(tx);
    if (!context.actorId) throw new SettingsForbiddenError();
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM staff_users WHERE id=${context.actorId}::uuid FOR SHARE`,
    );
    await authorized(tx, context.actorId);
    // Insert an unconfigured sentinel to lock even a missing key. It rolls back on any failure.
    const inserted = await tx.$executeRaw(
      Prisma.sql`INSERT INTO settings (key,value,updated_by) VALUES (${command.key}, 'null'::jsonb, ${context.actorId}::uuid) ON CONFLICT (key) DO NOTHING`,
    );
    await tx.$queryRaw(Prisma.sql`SELECT key FROM settings WHERE key=${command.key} FOR UPDATE`);
    const row = await tx.setting.findUniqueOrThrow({ where: { key: command.key } });
    return finish(tx, context, command, row, inserted > 0);
  });
}
async function finish(
  tx: Tx,
  context: CommandContext,
  command: SettingsWriteRequest,
  row: { key: string; value: unknown; version: number; updatedAt: Date; updatedBy: string },
  created: boolean,
) {
  if ((created ? 0 : row.version) !== command.version) throw new SettingsConflictError();
  if (!created && isDeepStrictEqual(row.value, command.value)) return response(command.key, row);
  await tx.$executeRaw(
    Prisma.sql`UPDATE settings SET value=${JSON.stringify(command.value)}::jsonb, version=${created ? 1 : row.version + 1}, updated_by=${context.actorId}::uuid, updated_at=statement_timestamp() WHERE key=${command.key}`,
  );
  const version = created ? 1 : row.version + 1;
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: "settings.updated",
      entity: { type: "setting", id: command.key },
      before: { version: created ? 0 : row.version },
      after: { version, configured: command.value !== null },
      reason: "configuration updated",
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("settings.updated", command.key, { key: command.key }, version),
  );
  return response(command.key, await tx.setting.findUniqueOrThrow({ where: { key: command.key } }));
}
