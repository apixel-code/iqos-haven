import { isDeepStrictEqual } from "node:util";
import {
  defineEvent,
  productOptionsWriteRequestSchema,
  productVariantsResponseSchema,
  variantCreateRequestSchema,
  variantUpdateRequestSchema,
  type ProductOptionsWriteRequest,
  type ProductVariantsResponse,
  type VariantCreateRequest,
  type VariantUpdateRequest,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
import {
  CatalogueConflictError,
  CatalogueNotFoundError,
  lockCatalogueActor,
  mapCatalogueError,
} from "./catalogue-parents";

/**
 * Product options and variants (roadmap step 45, ADR 0016). Every mutation locks the actor, then
 * the product row FOR UPDATE (serializing all option/variant changes of that product), then the
 * affected variants in sorted ID order. Cross-row rules are checked under that lock:
 * - option names change only while the product has no variants; values can be added any time
 *   and removed only when no variant uses them;
 * - a variant's attributes name exactly the product's options with allowed values (none for a
 *   product without options, so it has a single default variant);
 * - exactly one default variant, which stays active (the DB also keeps at most one default).
 * Stock is never written here: new variants start at zero (ledger guard, step 41).
 */
interface OptionRow {
  id: string;
  name: string;
  allowedValues: string[];
  version: number;
}
interface VariantRow {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  priceOverrideFils: bigint | null;
  stockOnHand: number;
  lowStockThreshold: number;
  active: boolean;
  isDefault: boolean;
  version: number;
  updatedAt: Date;
}

/** Locks the product row and returns its version; trashed products are read-only. */
async function lockProduct(tx: Tx, productId: string) {
  const [row] = await tx.$queryRaw<Array<{ version: number; trashed: boolean }>>(Prisma.sql`
    SELECT version, deleted_at IS NOT NULL AS trashed FROM products
    WHERE id=${productId}::uuid FOR UPDATE`);
  if (!row) throw new CatalogueNotFoundError();
  if (row.trashed) throw new CatalogueConflictError("TRASHED");
  return row.version;
}

const options = (tx: Database | Tx, productId: string) =>
  tx.$queryRaw<OptionRow[]>(Prisma.sql`
    SELECT id, name, allowed_values AS "allowedValues", version FROM product_options
    WHERE product_id=${productId}::uuid ORDER BY sort_order, name`);
const variants = (tx: Database | Tx, productId: string) =>
  tx.$queryRaw<VariantRow[]>(Prisma.sql`
    SELECT id, sku, attributes, price_override_fils AS "priceOverrideFils",
      stock_on_hand AS "stockOnHand", low_stock_threshold AS "lowStockThreshold", active,
      is_default AS "isDefault", version, updated_at AS "updatedAt"
    FROM variants WHERE product_id=${productId}::uuid ORDER BY id`);

async function snapshot(tx: Database | Tx, productId: string): Promise<ProductVariantsResponse> {
  const [product] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
    SELECT version FROM products WHERE id=${productId}::uuid`);
  if (!product) throw new CatalogueNotFoundError();
  return productVariantsResponseSchema.parse({
    productId,
    productVersion: product.version,
    options: (await options(tx, productId)).map((o) => ({ name: o.name, values: o.allowedValues })),
    variants: (await variants(tx, productId)).map((v) => ({
      ...v,
      // Bounded by the DB CHECK (≤ 1,000,000,000 fils), so the conversion is exact.
      priceOverrideFils: v.priceOverrideFils === null ? null : Number(v.priceOverrideFils),
      updatedAt: v.updatedAt.toISOString(),
    })),
  });
}

export async function readProductVariants(db: Database, actorId: string, productId: string) {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  // One snapshot for version, options and variants (a read-only, short transaction).
  return db.$transaction((tx) => snapshot(tx as unknown as Tx, productId), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

async function record(
  tx: Tx,
  context: CommandContext,
  action: string,
  entity: { type: "product" | "variant"; id: string },
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, { action, entity, before, after, reveal: ["sku"] }),
  );
}

/** Option/variant changes revalidate the product page: one IDs-only event per product change. */
async function productChanged(tx: Tx, productId: string) {
  const [row] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
    SELECT version FROM products WHERE id=${productId}::uuid`);
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent(
      "catalog.changed",
      productId,
      { entityType: "product", entityId: productId },
      row!.version,
    ),
  );
}

export async function writeProductOptions(
  db: Database,
  context: CommandContext,
  productId: string,
  input: ProductOptionsWriteRequest,
) {
  const command = productOptionsWriteRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      const productVersion = await lockProduct(tx, productId);
      if (productVersion !== command.productVersion)
        throw new CatalogueConflictError("VERSION_CONFLICT");
      const current = await options(tx, productId);
      const existing = await variants(tx, productId);
      const currentNames: string[] = current.map((o) => o.name).sort();
      const nextNames: string[] = command.options.map((o) => o.name).sort();
      if (
        isDeepStrictEqual(
          current.map((o) => [o.name, o.allowedValues]),
          command.options.map((o) => [o.name, o.values]),
        )
      )
        return snapshot(tx, productId);
      if (existing.length && !isDeepStrictEqual(currentNames, nextNames))
        throw new CatalogueConflictError("OPTIONS_IN_USE");
      for (const option of command.options) {
        const removed = (current.find((o) => o.name === option.name)?.allowedValues ?? []).filter(
          (value) => !option.values.includes(value),
        );
        if (existing.some((v) => removed.includes(v.attributes[option.name] ?? "")))
          throw new CatalogueConflictError("OPTIONS_IN_USE");
      }
      const removedIds = current.filter((o) => !nextNames.includes(o.name)).map((o) => o.id);
      if (removedIds.length)
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM product_options WHERE id IN (${Prisma.join(
            removedIds.map((id) => Prisma.sql`${id}::uuid`),
          )})`);
      for (const [index, option] of command.options.entries())
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO product_options (product_id, name, allowed_values, sort_order)
          VALUES (${productId}::uuid, ${option.name}, ${JSON.stringify(option.values)}::jsonb, ${index})
          ON CONFLICT (product_id, name) DO UPDATE
          SET allowed_values=EXCLUDED.allowed_values, sort_order=EXCLUDED.sort_order,
            version=product_options.version+1, updated_at=statement_timestamp()
          WHERE product_options.allowed_values IS DISTINCT FROM EXCLUDED.allowed_values
             OR product_options.sort_order IS DISTINCT FROM EXCLUDED.sort_order`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE products SET version=version+1, updated_at=statement_timestamp()
        WHERE id=${productId}::uuid`);
      // Option values are catalogue data (not personal), so the trail lists them.
      const values = (list: Array<{ name: string; values: string[] }>) =>
        Object.fromEntries(list.map((o) => [o.name, o.values]));
      await record(
        tx,
        context,
        "catalog.product_options_updated",
        { type: "product", id: productId },
        {
          options: values(current.map((o) => ({ name: o.name, values: o.allowedValues }))),
          version: productVersion,
        },
        { options: values(command.options), version: productVersion + 1 },
      );
      await productChanged(tx, productId);
      return snapshot(tx, productId);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}

/** Attributes must name exactly the product's options, each with an allowed value. */
function validCombination(optionRows: OptionRow[], attributes: Record<string, string>) {
  const names = Object.keys(attributes).sort();
  if (!isDeepStrictEqual(names, optionRows.map((o) => o.name).sort())) return false;
  return optionRows.every((o) => o.allowedValues.includes(attributes[o.name]!));
}

export async function createVariant(
  db: Database,
  context: CommandContext,
  productId: string,
  input: VariantCreateRequest,
) {
  const command = variantCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      await lockProduct(tx, productId);
      const optionRows = await options(tx, productId);
      if (!validCombination(optionRows, command.attributes))
        throw new CatalogueConflictError("INVALID_COMBINATION");
      const isFirst = (await variants(tx, productId)).length === 0;
      // The first variant becomes the default and must therefore be active.
      if (isFirst && !command.active) throw new CatalogueConflictError("DEFAULT_REQUIRED");
      const [inserted] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO variants (product_id, sku, attributes, price_override_fils,
          low_stock_threshold, active, is_default)
        VALUES (${productId}::uuid, ${command.sku}, ${JSON.stringify(command.attributes)}::jsonb,
          ${command.priceOverrideFils}, ${command.lowStockThreshold}, ${command.active}, ${isFirst})
        RETURNING id`);
      await record(
        tx,
        context,
        "catalog.variant_created",
        { type: "variant", id: inserted!.id },
        null,
        {
          productId,
          sku: command.sku,
          attributes: command.attributes,
          priceOverrideFils: command.priceOverrideFils,
          active: command.active,
          isDefault: isFirst,
          version: 1,
        },
      );
      await productChanged(tx, productId);
      return snapshot(tx, productId);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}

export async function updateVariant(
  db: Database,
  context: CommandContext,
  productId: string,
  variantId: string,
  input: VariantUpdateRequest,
) {
  const command = variantUpdateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      await lockProduct(tx, productId);
      // Lock the target and the current default (sorted IDs) before reading them: stock-ledger
      // writers update variant rows without the product lock, so reads must follow the lock.
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM variants
        WHERE product_id=${productId}::uuid AND (id=${variantId}::uuid OR is_default)
        ORDER BY id FOR UPDATE`);
      const all = await variants(tx, productId);
      const row = all.find((v) => v.id === variantId);
      if (!row) throw new CatalogueNotFoundError();
      const previousDefault = all.find((v) => v.isDefault && v.id !== variantId);
      if (row.version !== command.version) throw new CatalogueConflictError("VERSION_CONFLICT");
      if (row.isDefault && !command.isDefault) throw new CatalogueConflictError("DEFAULT_REQUIRED");
      if (command.isDefault && !command.active)
        throw new CatalogueConflictError("DEFAULT_REQUIRED");
      const price = row.priceOverrideFils === null ? null : Number(row.priceOverrideFils);
      const unchanged =
        row.sku === command.sku &&
        price === command.priceOverrideFils &&
        row.lowStockThreshold === command.lowStockThreshold &&
        row.active === command.active &&
        row.isDefault === command.isDefault;
      if (unchanged) return snapshot(tx, productId);
      const movingDefault = command.isDefault && !row.isDefault && previousDefault !== undefined;
      if (movingDefault && previousDefault)
        await tx.$executeRaw(Prisma.sql`
          UPDATE variants SET is_default=false, version=version+1, updated_at=statement_timestamp()
          WHERE id=${previousDefault.id}::uuid`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE variants SET sku=${command.sku}, price_override_fils=${command.priceOverrideFils},
          low_stock_threshold=${command.lowStockThreshold}, active=${command.active},
          is_default=${command.isDefault}, version=version+1, updated_at=statement_timestamp()
        WHERE id=${variantId}::uuid`);
      const view = (v: { sku: string; active: boolean; isDefault: boolean }, version: number) => ({
        productId,
        sku: v.sku,
        active: v.active,
        isDefault: v.isDefault,
        version,
      });
      await record(
        tx,
        context,
        "catalog.variant_updated",
        { type: "variant", id: variantId },
        {
          ...view(row, row.version),
          priceOverrideFils: price,
          lowStockThreshold: row.lowStockThreshold,
        },
        {
          ...view(command, row.version + 1),
          priceOverrideFils: command.priceOverrideFils,
          lowStockThreshold: command.lowStockThreshold,
        },
      );
      if (movingDefault && previousDefault)
        await record(
          tx,
          context,
          "catalog.variant_updated",
          { type: "variant", id: previousDefault.id },
          view(previousDefault, previousDefault.version),
          view({ ...previousDefault, isDefault: false }, previousDefault.version + 1),
        );
      await productChanged(tx, productId);
      return snapshot(tx, productId);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}
