import { isDeepStrictEqual } from "node:util";
import {
  deliveryAreaCreateRequestSchema,
  deliveryAreaUpdateRequestSchema,
  deliveryAreaResponseSchema,
  deliveryAreasQuerySchema,
  deliveryConfigurationSchema,
  deliveryConfigurationWriteRequestSchema,
  deliveryConfigurationResponseSchema,
  defineEvent,
  type DeliveryAreaCreateRequest,
  type DeliveryAreaUpdateRequest,
  type DeliveryAreasQuery,
  type DeliveryConfigurationWriteRequest,
} from "@ih/contracts";
import { deliveryForArea, DeliveryUnavailableError, isDeliverableArea } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { enterLockGroup, LockOrderError, withTransaction, isUnitOfWork } from "./transaction";
import { lockOwnerRole } from "./identity";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
export class DeliveryForbiddenError extends Error {}
export class DeliveryConflictError extends Error {}
export class DeliveryNotFoundError extends Error {}
async function authorized(tx: Database | Tx, actorId: string | null) {
  if (!actorId) throw new DeliveryForbiddenError();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT u.id FROM staff_users u WHERE u.id=${actorId}::uuid AND u.active AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=u.role_id AND p.key='delivery.manage')`,
  );
  if (!rows.length) throw new DeliveryForbiddenError();
}
async function authority(tx: Tx, context: CommandContext) {
  await lockOwnerRole(tx);
  if (!context.actorId) throw new DeliveryForbiddenError();
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM staff_users WHERE id=${context.actorId}::uuid FOR SHARE`,
  );
  await authorized(tx, context.actorId);
}
function areaResponse(row: { updatedAt: Date } & Record<string, unknown>) {
  return deliveryAreaResponseSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
}
function configurationResponse(
  row?: { value: unknown; version: number; updatedAt: Date; updatedBy: string } | null,
) {
  return deliveryConfigurationResponseSchema.parse({
    value: row?.value ?? null,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  });
}
export async function readDeliveryConfiguration(db: Database, actorId: string) {
  await authorized(db, actorId);
  return configurationResponse(await db.setting.findUnique({ where: { key: "delivery" } }));
}
export async function listDeliveryAreas(db: Database, actorId: string, input: DeliveryAreasQuery) {
  const query = deliveryAreasQuerySchema.parse(input);
  await authorized(db, actorId);
  const rows = await db.deliveryArea.findMany({
    where: query.after ? { id: { gt: query.after } } : {},
    orderBy: { id: "asc" },
    take: query.limit + 1,
  });
  const items = rows.slice(0, query.limit).map(areaResponse);
  return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
}
async function recordArea(
  tx: Tx,
  context: CommandContext,
  id: string,
  before: number,
  version: number,
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: "delivery.area_updated",
      entity: { type: "delivery_area", id },
      before: { version: before },
      after: { version },
      reason: before === 0 ? "delivery area created" : "delivery area updated",
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("delivery.area_updated", id, { areaId: id }, version),
  );
}
function mapUnique(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
    throw new DeliveryConflictError();
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010") {
    const meta = error.meta as
      { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
    if (meta?.code === "23505" || meta?.driverAdapterError?.cause?.originalCode === "23505")
      throw new DeliveryConflictError();
  }
  throw error;
}
export async function createDeliveryArea(
  db: Database,
  context: CommandContext,
  input: DeliveryAreaCreateRequest,
) {
  const command = deliveryAreaCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await authority(tx, context);
      const row = await tx.deliveryArea.create({
        data: { ...command, updatedBy: context.actorId! },
      });
      await recordArea(tx, context, row.id, 0, 1);
      return areaResponse(row);
    });
  } catch (error) {
    mapUnique(error);
  }
}
export async function updateDeliveryArea(
  db: Database,
  context: CommandContext,
  id: string,
  input: DeliveryAreaUpdateRequest,
) {
  const command = deliveryAreaUpdateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await authority(tx, context);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM delivery_areas WHERE id=${id}::uuid FOR UPDATE`);
      const row = await tx.deliveryArea.findUnique({ where: { id } });
      if (!row) throw new DeliveryNotFoundError();
      if (row.version !== command.version) throw new DeliveryConflictError();
      if (row.name === command.name && row.active === command.active) return areaResponse(row);
      await tx.$executeRaw(
        Prisma.sql`UPDATE delivery_areas SET name=${command.name},active=${command.active},version=version+1,updated_by=${context.actorId}::uuid,updated_at=statement_timestamp() WHERE id=${id}::uuid`,
      );
      const updated = await tx.deliveryArea.findUniqueOrThrow({ where: { id } });
      await recordArea(tx, context, id, row.version, updated.version);
      return areaResponse(updated);
    });
  } catch (error) {
    mapUnique(error);
  }
}
export async function writeDeliveryConfiguration(
  db: Database,
  context: CommandContext,
  input: DeliveryConfigurationWriteRequest,
) {
  const command = deliveryConfigurationWriteRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await authority(tx, context);
    const inserted = await tx.$executeRaw(
      Prisma.sql`INSERT INTO settings (key,value,updated_by) VALUES ('delivery','null'::jsonb,${context.actorId}::uuid) ON CONFLICT (key) DO NOTHING`,
    );
    await tx.$queryRaw(Prisma.sql`SELECT key FROM settings WHERE key='delivery' FOR UPDATE`);
    const row = await tx.setting.findUniqueOrThrow({ where: { key: "delivery" } });
    const before = inserted ? 0 : row.version;
    if (before !== command.version) throw new DeliveryConflictError();
    if (!inserted && isDeepStrictEqual(row.value, command.value)) return configurationResponse(row);
    const version = before + 1;
    await tx.$executeRaw(
      Prisma.sql`UPDATE settings SET value=${JSON.stringify(command.value)}::jsonb,version=${version},updated_by=${context.actorId}::uuid,updated_at=statement_timestamp() WHERE key='delivery'`,
    );
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "delivery.configuration_updated",
        entity: { type: "setting", id: "delivery" },
        before: { version: before },
        after: { version, configured: command.value !== null },
        reason: "delivery configuration updated",
      }),
    );
    await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("delivery.configuration_updated", "delivery", { key: "delivery" }, version),
    );
    return configurationResponse(
      await tx.setting.findUniqueOrThrow({ where: { key: "delivery" } }),
    );
  });
}
/**
 * Checkout validation before a quote: the chosen area must exist, be active and be in Dubai.
 * Unknown and inactive areas are indistinguishable (`DeliveryUnavailableError`). Takes no lock:
 * the quote/order transaction decides again under `lockDeliverySelection`.
 */
export async function readDeliverableArea(db: Database | Tx, areaId: string) {
  // A malformed ID must look like an unknown area, not like a database error.
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(areaId))
    throw new DeliveryUnavailableError();
  const area = await db.deliveryArea.findUnique({
    where: { id: areaId },
    select: { id: true, code: true, name: true, active: true, emirate: true },
  });
  if (!area || !isDeliverableArea(area)) throw new DeliveryUnavailableError();
  return { id: area.id, code: area.code, name: area.name };
}
const AREA_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Areas each open transaction holds FOR SHARE, and transactions that referenced an area first. */
const heldAreas = new WeakMap<object, Set<string>>();
const areaReferencedFirst = new WeakSet<object>();
/** True when `lockDeliverySelection` already holds this area in the transaction. */
export function holdsDeliveryArea(tx: unknown, areaId: string): boolean {
  return typeof tx === "object" && tx !== null && !!heldAreas.get(tx)?.has(areaId.toLowerCase());
}
/**
 * A write that references an area (a saved address) takes a key-share lock on it. Without the
 * settings lock taken first that inverts "settings, then area", so such a transaction may not
 * ask for the delivery selection afterwards.
 */
export function noteAreaReference(tx: object): void {
  areaReferencedFirst.add(tx);
}
async function deliverySelection(tx: Database | Tx, areaId: string, lock: boolean) {
  // A malformed ID must look like an unknown area, not like a database error.
  if (!AREA_ID.test(areaId)) throw new DeliveryUnavailableError();
  if (lock) await tx.$queryRaw(Prisma.sql`SELECT key FROM settings WHERE key='delivery' FOR SHARE`);
  const setting = await tx.setting.findUnique({ where: { key: "delivery" } });
  if (lock)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM delivery_areas WHERE id=${areaId}::uuid FOR SHARE`,
    );
  const area = await tx.deliveryArea.findUnique({ where: { id: areaId } });
  const config =
    setting?.value === null || !setting ? null : deliveryConfigurationSchema.parse(setting.value);
  // Area first, then configuration: an unknown area is reported as such even when unconfigured.
  const delivery = deliveryForArea(config, area);
  return {
    ...delivery,
    /** Free delivery is off at launch; the configuration cannot hold a threshold. */
    freeThresholdFils: null,
    areaId: area!.id,
    areaCode: area!.code,
    areaName: area!.name,
    emirate: area!.emirate,
    areaVersion: area!.version,
    configurationVersion: setting!.version,
  };
}
export type DeliverySelection = Awaited<ReturnType<typeof deliverySelection>>;
/** The flat fee, ETA and versions for an area, without locks: for a quote preview. */
export async function readDeliverySelection(db: Database | Tx, areaId: string) {
  return deliverySelection(db, areaId, false);
}
/** Internal quote/order primitive. Caller must hold earlier resource locks; retains shared
 * settings then area locks until commit so edits/deactivation cannot invalidate the snapshot. */
export async function lockDeliverySelection(tx: Tx, areaId: string) {
  if (!isUnitOfWork(tx)) throw new Error("Delivery selection requires a unit of work");
  enterLockGroup(tx, "delivery");
  if (areaReferencedFirst.has(tx)) throw new LockOrderError("delivery", "delivery");
  const selection = await deliverySelection(tx, areaId, true);
  const held = heldAreas.get(tx) ?? new Set<string>();
  heldAreas.set(tx, held);
  held.add(selection.areaId.toLowerCase());
  return selection;
}
/**
 * What the checkout form needs (roadmap step 70): the active areas to choose from and the one
 * flat fee and ETA. No versions, codes or staff fields. `feeFils` is null until the Owner has
 * configured delivery; the storefront then cannot offer checkout.
 */
export async function readStoreDelivery(db: Database) {
  const setting = await db.setting.findUnique({ where: { key: "delivery" } });
  const config =
    setting?.value === null || !setting ? null : deliveryConfigurationSchema.parse(setting.value);
  const areas = await db.deliveryArea.findMany({
    where: { active: true },
    select: { id: true, name: true, emirate: true },
    orderBy: [{ emirate: "asc" }, { name: "asc" }, { id: "asc" }],
    // Far above any real coverage list; a longer list would be cut here, not paged.
    take: 500,
  });
  return {
    feeFils: config?.flatFeeFils ?? null,
    etaText: config?.etaText ?? null,
    freeThresholdFils: null,
    areas: areas.filter((area) => isDeliverableArea({ ...area, active: true })),
  };
}
