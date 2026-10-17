import {
  orderItemChoicesResponseSchema,
  type OrderItemChoicesQuery,
  type OrderItemChoicesResponse,
} from "@ih/contracts";
import { Prisma, type Database } from "./client";
import { PRODUCT_FROM, VISIBLE_PRODUCT } from "./store-catalogue";

const CHOICE_LIMIT = 30;
const escapedLike = (value: string) => "%" + value.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

/**
 * Item picker for manual orders and order edits (parity G-A1, ADR 0080): the variants the
 * order transaction would accept now, i.e. the same rule as `priceRows` (store visibility, an
 * active variant, a price above zero). Matches product name, brand name or SKU. Read-only.
 */
export async function searchOrderItemChoices(
  db: Database,
  query: OrderItemChoicesQuery,
): Promise<OrderItemChoicesResponse> {
  const q = query.q?.trim();
  const match = q
    ? Prisma.sql`AND (p.name ILIKE ${escapedLike(q)} ESCAPE '\\'
        OR b.name ILIKE ${escapedLike(q)} ESCAPE '\\'
        OR cv.sku ILIKE ${escapedLike(q)} ESCAPE '\\')`
    : Prisma.empty;
  const rows = await db.$queryRaw<
    Array<{
      variantId: string;
      productName: string;
      brandName: string;
      sku: string;
      options: string | null;
      unitPriceFils: number;
      soldOut: boolean;
    }>
  >(Prisma.sql`
    SELECT cv.id AS "variantId", p.name AS "productName", b.name AS "brandName", cv.sku,
      (SELECT string_agg(cv.attributes->>po.name, ' · ' ORDER BY po.sort_order, po.name)
        FROM product_options po
        WHERE po.product_id=p.id AND cv.attributes ? po.name) AS options,
      -- Both columns are CHECKed to at most 1,000,000,000 fils, so the value fits an int.
      coalesce(cv.price_override_fils, p.base_price_fils)::int AS "unitPriceFils",
      cv.stock_on_hand <= 0 AS "soldOut"
    ${PRODUCT_FROM}
    JOIN variants cv ON cv.product_id=p.id
    WHERE cv.active AND ${VISIBLE_PRODUCT}
      AND coalesce(cv.price_override_fils, p.base_price_fils) > 0
      ${match}
    ORDER BY p.name, cv.sku, cv.id
    LIMIT ${CHOICE_LIMIT}`);
  return orderItemChoicesResponseSchema.parse({
    items: rows.map((row) => ({ ...row, options: row.options ?? "" })),
  });
}
