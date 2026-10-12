import {
  mergeOrderLines,
  priceOrder,
  type OrderLine,
  type PricedOrder,
  type PricingLineInput,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { VISIBLE_PRODUCT } from "./store-catalogue";
import { enterLockGroup, isUnitOfWork, TransactionRestartError } from "./transaction";

/** One or more lines cannot be bought: hidden, unpublished, deactivated or unknown variants. */
export class VariantUnavailableError extends Error {
  readonly code = "VARIANT_UNAVAILABLE";
  constructor(readonly variantIds: readonly string[]) {
    super("Variant unavailable");
  }
}
export interface OrderPriceLine extends PricingLineInput {
  productId: string;
  /** Versions the price was read at; part of the quote fingerprint (step 71). */
  productVersion: number;
  variantVersion: number;
}
interface PriceRow extends OrderPriceLine {
  brandId: string;
  categoryId: string;
}
async function priceRows(db: Database | Tx, lines: readonly OrderLine[]) {
  const ids = lines.map((line) => line.variantId);
  const rows = await db.$queryRaw<Array<Omit<PriceRow, "quantity">>>(Prisma.sql`
    SELECT cv.id AS "variantId", p.id AS "productId", p.brand_id AS "brandId",
      p.category_id AS "categoryId",
      -- Both columns are CHECKed to at most 1,000,000,000 fils, so the value fits an int.
      coalesce(cv.price_override_fils, p.base_price_fils)::int AS "unitPriceFils",
      p.version AS "productVersion", cv.version AS "variantVersion"
    FROM variants cv
    JOIN products p ON p.id=cv.product_id
    JOIN brands b ON b.id=p.brand_id
    JOIN categories c ON c.id=p.category_id
    WHERE cv.id = ANY(${ids}::uuid[]) AND cv.active AND ${VISIBLE_PRODUCT}
      AND coalesce(cv.price_override_fils, p.base_price_fils) > 0
    ORDER BY cv.id`);
  const found = new Map(rows.map((row) => [row.variantId, row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new VariantUnavailableError(missing);
  return lines.map((line): PriceRow => ({
    ...found.get(line.variantId)!,
    quantity: line.quantity,
  }));
}
const publicLine = ({
  brandId: _brand,
  categoryId: _category,
  ...line
}: PriceRow): OrderPriceLine => line;
/**
 * Current server prices of the lines of a cart: the active variant's override or its product's
 * price, for variants a shopper may see (the store visibility rule). Client prices are never an
 * input. Takes no lock: for a quote preview only; the order decides again with
 * `lockOrderPrices`.
 */
export async function readOrderPrices(
  db: Database | Tx,
  lines: readonly OrderLine[],
): Promise<OrderPriceLine[]> {
  return (await priceRows(db, mergeOrderLines(lines))).map(publicLine);
}
/**
 * Catalogue group of the resource order (after customer and settings/area, before coupons and
 * variants). Holds the brands, categories and products of the lines FOR SHARE, each in ID
 * order, until commit. Every price, publish, trash and visibility change takes one of those
 * rows FOR UPDATE first, so what is read here cannot change before the order commits. Variant
 * rows are not locked here: stock takes them FOR UPDATE later, and a shared lock now would
 * deadlock two orders of the same variant.
 */
export async function lockOrderPrices(
  tx: Tx,
  lines: readonly OrderLine[],
): Promise<OrderPriceLine[]> {
  if (!isUnitOfWork(tx)) throw new Error("Locking prices requires a unit of work");
  const merged = mergeOrderLines(lines);
  enterLockGroup(tx, "catalogue");
  const ids = merged.map((line) => line.variantId);
  const owners = Prisma.sql`SELECT p.id, p.brand_id, p.category_id FROM products p
    WHERE p.id IN (SELECT v.product_id FROM variants v WHERE v.id = ANY(${ids}::uuid[]))`;
  const locked = async (table: "brands" | "categories" | "products", column: Prisma.Sql) =>
    new Set(
      (
        await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM ${Prisma.raw(table)}
            WHERE id IN (SELECT ${column} FROM (${owners}) o) ORDER BY id FOR SHARE`,
        )
      ).map((row) => row.id),
    );
  const brands = await locked("brands", Prisma.sql`o.brand_id`);
  const categories = await locked("categories", Prisma.sql`o.category_id`);
  await locked("products", Prisma.sql`o.id`);
  const rows = await priceRows(tx, merged);
  // A product moved to another brand or category between the parent locks and its own lock:
  // the new parent is not held, so `withTransaction` starts the whole transaction again.
  if (rows.some((row) => !brands.has(row.brandId) || !categories.has(row.categoryId)))
    throw new TransactionRestartError("Catalogue changed while pricing");
  return rows.map(publicLine);
}
/** Totals for already-read prices. Discount and delivery fee come from server state only. */
export function priceOrderLines(
  lines: readonly OrderPriceLine[],
  terms: { discountBasisPoints?: number; deliveryFeeFils: number },
): PricedOrder {
  return priceOrder({
    lines: lines.map(({ variantId, quantity, unitPriceFils }) => ({
      variantId,
      quantity,
      unitPriceFils,
    })),
    ...terms,
  });
}
