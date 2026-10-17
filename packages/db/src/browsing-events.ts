import {
  normalizeSearchTerm,
  storeEventsRequestSchema,
  type StoreEventsRequest,
  type StoreEventsResponse,
} from "@ih/contracts";
import { Prisma, type Database } from "./client";
import { PRODUCT_FROM, VISIBLE_PRODUCT } from "./store-catalogue";

/**
 * Stores a batch of anonymous browsing events (roadmap step 103, ADR 0069). Product slugs are
 * resolved to product IDs here (current or former slug, visible products only) and variants
 * must be active on a visible product; anything else is dropped. One statement, no
 * transaction around anything else: telemetry never holds commerce locks. A resent event ID is
 * counted once.
 */
export async function storeBrowsingEvents(
  db: Database,
  input: StoreEventsRequest,
): Promise<StoreEventsResponse> {
  const request = storeEventsRequestSchema.parse(input);
  const slugs = [
    ...new Set(
      request.events.flatMap((event) => ("productSlug" in event ? [event.productSlug] : [])),
    ),
  ];
  const variantIds = [
    ...new Set(request.events.flatMap((event) => ("variantId" in event ? [event.variantId] : []))),
  ];
  const products = new Map(
    (slugs.length
      ? await db.$queryRaw<Array<{ slug: string; id: string }>>(Prisma.sql`
          SELECT DISTINCT ON (s.slug) s.slug, p.id ${PRODUCT_FROM}
          JOIN unnest(${slugs}::text[]) AS s(slug) ON p.slug=s.slug OR p.id=(
            SELECT r.product_id FROM slug_redirects r
            WHERE r.entity_type='product' AND r.old_slug=s.slug)
          WHERE ${VISIBLE_PRODUCT}
          -- The current slug wins over a former one that happens to match too.
          ORDER BY s.slug, (p.slug=s.slug) DESC`)
      : []
    ).map((row) => [row.slug, row.id]),
  );
  const variants = new Map(
    (variantIds.length
      ? await db.$queryRaw<Array<{ variantId: string; productId: string }>>(Prisma.sql`
          SELECT v.id AS "variantId", p.id AS "productId" ${PRODUCT_FROM}
          JOIN variants v ON v.product_id=p.id
          WHERE v.id = ANY(${variantIds}::uuid[]) AND v.active AND ${VISIBLE_PRODUCT}`)
      : []
    ).map((row) => [row.variantId, row.productId]),
  );

  const rows: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
  for (const event of request.events) {
    switch (event.type) {
      case "search":
        rows.push({
          id: event.id,
          type: event.type,
          payload: { term: normalizeSearchTerm(event.term), resultCount: event.resultCount },
        });
        break;
      case "product_view":
      case "wishlist_add":
      case "wishlist_remove": {
        const productId = products.get(event.productSlug);
        if (productId) rows.push({ id: event.id, type: event.type, payload: { productId } });
        break;
      }
      case "cart_add":
      case "cart_remove": {
        const productId = variants.get(event.variantId);
        if (productId)
          rows.push({
            id: event.id,
            type: event.type,
            payload: { productId, variantId: event.variantId, quantity: event.quantity },
          });
        break;
      }
    }
  }
  const dropped = request.events.length - rows.length;
  if (!rows.length) return { stored: 0, duplicate: 0, dropped };
  // A search is never linked to the browser's other events: no anonymous ID on search rows.
  const anonymousId = request.anonymousId ?? null;
  const stored = await db.$transaction(async (tx) => {
    // Telemetry gives up quickly rather than hold a pooled connection.
    await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '2s'`);
    return tx.$executeRaw(Prisma.sql`
      INSERT INTO events (id, type, payload, anonymous_id)
      SELECT x.id, x.type, x.payload,
        CASE WHEN x.type='search' THEN NULL ELSE ${anonymousId}::uuid END
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS x(id uuid, type text, payload jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
  return { stored, duplicate: rows.length - stored, dropped };
}

/** Raw events kept this long (BI-08); the daily totals (step 106) are kept. */
export const BROWSING_EVENT_RETENTION_DAYS = 90;
/** Deletes up to `limit` events older than the retention window; returns how many. */
export async function deleteExpiredBrowsingEvents(db: Database, limit: number): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events
      WHERE received_at < statement_timestamp()
        - make_interval(days => ${BROWSING_EVENT_RETENTION_DAYS}::int)
      ORDER BY received_at LIMIT ${limit})`);
}
