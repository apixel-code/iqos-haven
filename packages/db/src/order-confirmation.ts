import { formatOrderNumber } from "@ih/domain";
import { orderConfirmationResponseSchema } from "@ih/contracts";
import { Prisma, type Database } from "./client";
/** One indexed, DB-clock-authorized read; only the confirmation snapshot fields leave SQL. */
export async function readOrderConfirmation(db: Database, hash: Buffer) {
  const [row] = await db.$queryRaw<
    Array<{ orderNumber: string; value: Record<string, unknown> }>
  >(Prisma.sql`
 SELECT order_number::text AS "orderNumber", jsonb_build_object(
   'placedAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'status',status,'totalFils',total_fils,'deliveryFeeFils',delivery_fee_fils,'discountFils',discount_fils,
   'etaText',delivery_eta_text,'address',jsonb_build_object('area',area_name,'emirate',area_emirate,
     'type',address_type,'building',address_building,'unit',address_unit,'street',address_street),
   'items',(SELECT jsonb_agg(jsonb_build_object('name',product_name,'attributes',attributes,
     'quantity',quantity,'unitPriceFils',unit_price_fils,'totalFils',total_fils) ORDER BY id)
     FROM order_items WHERE order_id=o.id)) AS value
 FROM orders o WHERE confirmation_hash=${hash} AND confirmation_expires_at>statement_timestamp()`);
  return row
    ? orderConfirmationResponseSchema.parse({
        ...row.value,
        orderNumber: formatOrderNumber(row.orderNumber),
      })
    : null;
}
/** No raw capability here. Restoring a cookie requires the API-only encryption ring. */
export async function readConfirmationReplay(db: Database, scope: string, keyHash: Buffer) {
  const [row] = await db.$queryRaw<
    Array<{ material: Buffer; hash: Buffer; expiresAt: Date }>
  >(Prisma.sql`
 SELECT i.replay_cookie_material AS material,o.confirmation_hash AS hash,o.confirmation_expires_at AS "expiresAt"
 FROM idempotency_records i JOIN orders o ON o.id=i.resource_id
 WHERE i.scope=${scope} AND i.key_hash=${keyHash} AND i.resource_type='order'
 AND o.creation_scope=i.scope AND o.creation_key_hash=i.key_hash
 AND i.replay_cookie_material IS NOT NULL AND i.expires_at>statement_timestamp()
 AND i.replay_cookie_expires_at=o.confirmation_expires_at AND o.confirmation_expires_at>statement_timestamp()`);
  return row ? { ...row, material: Buffer.from(row.material), hash: Buffer.from(row.hash) } : null;
}
export async function clearExpiredConfirmationReplay(db: Database, limit = 1000) {
  const batch = Math.min(Math.max(Math.trunc(limit), 1), 5000);
  return db.$executeRaw(Prisma.sql`UPDATE idempotency_records SET replay_cookie_material=NULL,replay_cookie_expires_at=NULL
 WHERE id IN (SELECT id FROM idempotency_records WHERE replay_cookie_expires_at<=statement_timestamp()
 ORDER BY replay_cookie_expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)`);
}
