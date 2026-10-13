import { mergeOrderLines, type OrderLine } from "@ih/domain";
import { Prisma, type Tx } from "./client";
import { lockCustomerForOrder, type CustomerIdentityInput } from "./customers";
import { VariantUnavailableError } from "./pricing";
import { lockQuoteForOrder, type QuoteInput } from "./quote";
import { enterLockGroup, sortedForLocking } from "./transaction";

/**
 * Canonical lock walk of commerce transactions (roadmap step 75, ADR 0044):
 *
 *   idempotency claim → existing order → customer → settings and area → brands, categories and
 *   products → coupon → variants
 *
 * Each primitive announces its group with `enterLockGroup`, so a transaction that asks for an
 * earlier group after a later one fails at once instead of deadlocking under load. Read
 * Committed throughout (`withTransaction`).
 */
export class OrderNotFoundError extends Error {}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface LockedOrder {
  id: string;
  orderNumber: string;
  status: string;
  version: number;
  customerId: string;
  codStatus: string;
}
/**
 * "Existing order" group: every edit, status change, cancellation and collection takes the
 * order row FOR UPDATE before anything else it touches, so two commands on one order run one
 * after the other and each sees the other's result.
 */
export async function lockOrder(tx: Tx, orderId: string): Promise<LockedOrder> {
  enterLockGroup(tx, "order");
  // A malformed ID is an unknown order, not a database error.
  if (!UUID.test(orderId)) throw new OrderNotFoundError();
  const [row] = await tx.$queryRaw<LockedOrder[]>(Prisma.sql`
    SELECT id, order_number::text AS "orderNumber", status, version,
      customer_id AS "customerId", cod_status AS "codStatus"
    FROM orders WHERE id=${orderId}::uuid FOR UPDATE`);
  if (!row) throw new OrderNotFoundError();
  return row;
}
export interface LockedVariant {
  variantId: string;
  productId: string;
  stockOnHand: number;
  active: boolean;
  version: number;
  lowStockThreshold: number;
}
/**
 * "Variants" group, always last: the variant rows FOR UPDATE in ID order, with their stock.
 * Whoever changes stock holds this lock, so the balance read here is the one to decide on.
 * A variant that does not exist makes the whole command fail.
 */
export async function lockVariantsForStock(
  tx: Tx,
  variantIds: readonly string[],
): Promise<LockedVariant[]> {
  enterLockGroup(tx, "variants");
  const malformed = variantIds.filter((id) => !UUID.test(id));
  if (malformed.length) throw new VariantUnavailableError(malformed);
  const ids = sortedForLocking(variantIds.map((id) => id.toLowerCase()));
  if (!ids.length) return [];
  const rows = await tx.$queryRaw<LockedVariant[]>(Prisma.sql`
    SELECT id AS "variantId", product_id AS "productId", stock_on_hand AS "stockOnHand", active,
      version, low_stock_threshold AS "lowStockThreshold"
    FROM variants WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`);
  const found = new Set(rows.map((row) => row.variantId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new VariantUnavailableError(missing);
  return rows;
}
/**
 * Everything an order creation locks and reads, in the canonical order, after its idempotency
 * claim: the customer, then the quote (settings and area, catalogue, coupon), then the variants.
 * Returns what was read under those locks; the caller decides stock, writes the order and its
 * effects, and commits. Nothing here writes except finding or creating the customer.
 */
export async function lockForOrderCreation(
  tx: Tx,
  input: { customer: CustomerIdentityInput; quote: QuoteInput },
) {
  const lines: OrderLine[] = mergeOrderLines(input.quote.lines);
  const customer = await lockCustomerForOrder(tx, input.customer);
  const quote = await lockQuoteForOrder(tx, { ...input.quote, lines });
  const variants = await lockVariantsForStock(
    tx,
    lines.map((line) => line.variantId),
  );
  return { customer: customer.customer, customerCreated: customer.created, quote, variants };
}
