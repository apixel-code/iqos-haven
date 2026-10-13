import { defineEvent, type CheckoutAddress, type CheckoutContact } from "@ih/contracts";
import { formatOrderNumber, mergeOrderLines, type OrderLine } from "@ih/domain";
import { toAuditEntry } from "@ih/application";
import { PrismaAuditWriter } from "./audit";
import { Prisma, type Database } from "./client";
import { redeemCoupon } from "./coupons";
import { markCustomerFirstOrder, saveCustomerAddress } from "./customers";
import {
  canonicalPayloadHash,
  IdempotencyExpiredError,
  idempotencyKeyHash,
  runIdempotent,
} from "./idempotency";
import { publishLowStockCrossing } from "./inventory";
import { lockForOrderCreation } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { quoteChargeFacts, type QuoteChargeFacts } from "./quote";
import { TransactionRestartError } from "./transaction";

/**
 * Order creation (roadmap step 76, ADR 0045). One transaction: the idempotency claim, the
 * locks in canonical order, the quote the shopper accepted checked against what is true now,
 * stock taken through the ledger, the order with its lines and first history row, the coupon
 * use, the saved address, the audit entry, the `order.created` event and the answer to replay.
 * All of it commits or none of it does. No network call happens inside.
 */
export const STORE_CHECKOUT_SCOPE = "store.checkout";
/** One or more lines cannot be filled from stock. Carries variant IDs only. */
export class InsufficientStockError extends Error {
  readonly code = "INSUFFICIENT_STOCK";
  constructor(readonly variantIds: readonly string[]) {
    super("Insufficient stock");
  }
}
/** The total the shopper accepted is not the total now, or the acceptance is too old. */
export class QuoteNotAcceptedError extends Error {
  constructor(readonly code: "QUOTE_CHANGED" | "QUOTE_EXPIRED") {
    super("Quote not accepted");
  }
}
export interface CreateStoreOrderInput {
  /** The checkout attempt's key. Never stored or logged; only its hash is kept. */
  idempotencyKey: string;
  /** Normalized by `checkoutContactSchema`. */
  contact: CheckoutContact;
  /** Normalized by `checkoutAddressSchema`. */
  address: CheckoutAddress;
  lines: readonly OrderLine[];
  /** Normalized code or null. */
  couponCode: string | null;
  quote: {
    /** The fingerprint the shopper's token names; part of what makes two requests the same. */
    fingerprint: string;
    /** Decides, from the facts recomputed under the locks, whether that is what was accepted. */
    accept: (facts: QuoteChargeFacts) => "ACCEPTED" | "QUOTE_CHANGED" | "QUOTE_EXPIRED";
  };
  /** The second 18+ confirmation given at checkout. */
  age: { policyVersion: string };
  requestId: string;
  confirmation?: { hash: Buffer; material: Buffer };
}
/** The answer given for a placed order, and given again on a retry. Nothing personal. */
export interface OrderPlacedResponse extends Record<string, unknown> {
  orderNumber: string;
  totalFils: number;
  placedAt: string;
}
interface Snapshot {
  variantId: string;
  sku: string;
  attributes: unknown;
  lowStockThreshold: number;
  productName: string;
  productSlug: string;
  brandName: string;
  categoryName: string;
}
export async function createStoreOrder(
  db: Database,
  input: CreateStoreOrderInput,
): Promise<{ replayed: boolean; orderId: string | null; response: OrderPlacedResponse }> {
  const lines = mergeOrderLines(input.lines);
  // Two requests are the same order when all of this is the same.
  const payloadHash = canonicalPayloadHash({
    contact: { name: input.contact.name, phone: input.contact.phone },
    address: { ...input.address },
    lines: lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
    couponCode: input.couponCode,
    quoteFingerprint: input.quote.fingerprint,
    agePolicyVersion: input.age.policyVersion,
  });
  const keyHash = idempotencyKeyHash(STORE_CHECKOUT_SCOPE, input.idempotencyKey);
  const result = await runIdempotent<OrderPlacedResponse>(
    db,
    {
      scope: STORE_CHECKOUT_SCOPE,
      key: input.idempotencyKey,
      payloadHash,
      ttlSeconds: 24 * 60 * 60,
    },
    // A replay returns before this runs: it needs the exact key and payload, not a live token.
    async (tx) => {
      // The ledger forgets a key once its answer is cleaned up; the order never does.
      const [existing] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM orders
        WHERE creation_scope=${STORE_CHECKOUT_SCOPE} AND creation_key_hash=${keyHash}`);
      if (existing) throw new IdempotencyExpiredError("order", existing.id);

      const { customer, quote, variants } = await lockForOrderCreation(tx, {
        customer: { phone: input.contact.phone, displayName: input.contact.name },
        quote: { lines, areaId: input.address.areaId, couponCode: input.couponCode },
      });
      const decision = input.quote.accept(quoteChargeFacts(quote));
      if (decision !== "ACCEPTED") throw new QuoteNotAcceptedError(decision);

      // Stock is decided here, under the variant locks, and nowhere earlier.
      const stock = new Map(variants.map((row) => [row.variantId, row]));
      const short = lines.filter((line) => {
        const row = stock.get(line.variantId);
        return !row || !row.active || row.stockOnHand < line.quantity;
      });
      if (short.length) throw new InsufficientStockError(short.map((line) => line.variantId));
      // Prices were read before the variant rows were locked. Every variant edit takes its
      // product first, which this transaction holds, so the versions cannot differ; if they
      // ever do, start again rather than record a snapshot that does not match its version.
      if (quote.lines.some((line) => stock.get(line.variantId)!.version !== line.variantVersion))
        throw new TransactionRestartError("Variant changed while the order was being priced");

      const snapshots = new Map(
        (
          await tx.$queryRaw<Snapshot[]>(Prisma.sql`
            SELECT v.id AS "variantId", v.sku, v.attributes,
              v.low_stock_threshold AS "lowStockThreshold", p.name AS "productName",
              p.slug AS "productSlug", b.name AS "brandName", c.name AS "categoryName"
            FROM variants v
            JOIN products p ON p.id=v.product_id
            JOIN brands b ON b.id=p.brand_id
            JOIN categories c ON c.id=p.category_id
            WHERE v.id = ANY(${lines.map((line) => line.variantId)}::uuid[])`)
        ).map((row) => [row.variantId, row]),
      );

      const { address } = input;
      const [order] = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          createdAt: Date;
        }>
      >(Prisma.sql`
        INSERT INTO orders (customer_id, status, source, customer_name, customer_phone_e164,
          area_id, area_code, area_name, area_emirate, address_type, address_building,
          address_unit, address_street, address_makani, address_notes,
          merchandise_subtotal_fils, discount_fils, delivery_fee_fils, total_fils,
          coupon_code, coupon_percent_bps, delivery_eta_text, area_version,
          delivery_configuration_version, quote_fingerprint, age_confirmed_at,
          age_policy_version, creation_scope, creation_key_hash, creation_payload_hash, confirmation_hash, confirmation_expires_at)
        VALUES (${customer.id}::uuid, 'pending', 'storefront', ${customer.displayName},
          ${customer.phoneE164},
          ${quote.delivery.areaId}::uuid, ${quote.delivery.areaCode}, ${quote.delivery.areaName},
          ${quote.delivery.emirate}, ${address.type}, ${address.building},
          ${address.unit}, ${address.street}, ${address.makani}, ${address.notes},
          ${quote.merchandiseSubtotalFils}, ${quote.discountFils}, ${quote.deliveryFeeFils},
          ${quote.totalFils}, ${quote.coupon?.code ?? null},
          ${quote.coupon?.percentBps ?? null}::int, ${quote.delivery.etaText},
          ${quote.delivery.areaVersion}, ${quote.delivery.configurationVersion},
          ${input.quote.fingerprint}, statement_timestamp(), ${input.age.policyVersion},
          ${STORE_CHECKOUT_SCOPE}, ${keyHash}, ${payloadHash}, ${input.confirmation?.hash ?? null},
          CASE WHEN ${!!input.confirmation} THEN statement_timestamp()+interval '30 minutes' ELSE NULL END)
        RETURNING id, order_number::text AS "orderNumber", created_at AS "createdAt"`);
      const orderId = order!.id;

      for (const line of quote.lines) {
        const snapshot = snapshots.get(line.variantId)!;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_slug,
            brand_name, category_name, sku, attributes, product_version, variant_version,
            unit_price_fils, quantity, subtotal_fils, discount_fils, total_fils)
          VALUES (${orderId}::uuid, ${line.productId}::uuid, ${line.variantId}::uuid,
            ${snapshot.productName}, ${snapshot.productSlug}, ${snapshot.brandName},
            ${snapshot.categoryName}, ${snapshot.sku}, ${JSON.stringify(snapshot.attributes)}::jsonb,
            ${line.productVersion}, ${line.variantVersion}, ${line.unitPriceFils},
            ${line.quantity}, ${line.subtotalFils}, ${line.discountFils}, ${line.totalFils})`);
      }
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind,
          command_id, order_version)
        VALUES (${orderId}::uuid, NULL, 'pending', 'customer', 'order.create', 1)`);

      // One sale movement per line; the ledger trigger applies it and checks the balance.
      for (const line of lines) {
        const before = stock.get(line.variantId)!;
        const after = before.stockOnHand - line.quantity;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id,
            effect, order_id)
          VALUES (${line.variantId}::uuid, ${-line.quantity}, ${after}, 'SALE',
            ${"order:" + orderId}, 'sale', ${orderId}::uuid)`);
        const threshold = snapshots.get(line.variantId)!.lowStockThreshold;
        await publishLowStockCrossing(
          tx,
          line.variantId,
          "stock",
          { stock: before.stockOnHand, threshold },
          { stock: after, threshold },
        );
      }
      if (quote.appliedCoupon) await redeemCoupon(tx, orderId, quote.appliedCoupon);
      await saveCustomerAddress(tx, customer.id, address);
      await markCustomerFirstOrder(tx, customer.id);

      const response: OrderPlacedResponse = {
        orderNumber: formatOrderNumber(order!.orderNumber),
        totalFils: quote.totalFils,
        placedAt: order!.createdAt.toISOString(),
      };
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(
          { requestId: input.requestId, actorId: null },
          {
            action: "order.created",
            entity: { type: "order", id: orderId },
            before: null,
            // What was ordered and charged; never who ordered or where it goes.
            after: {
              orderNumber: response.orderNumber,
              status: "pending",
              source: "storefront",
              lineCount: lines.length,
              merchandiseSubtotalFils: quote.merchandiseSubtotalFils,
              discountFils: quote.discountFils,
              deliveryFeeFils: quote.deliveryFeeFils,
              totalFils: quote.totalFils,
              couponCode: quote.coupon?.code ?? null,
            },
            reason: "storefront checkout",
          },
        ),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("order.created", orderId, { orderId }, 1),
      );
      return {
        response,
        resourceType: "order",
        resourceId: orderId,
        ...(input.confirmation
          ? {
              replayCookieMaterial: input.confirmation.material,
            }
          : {}),
      };
    },
  );
  return { replayed: result.replayed, orderId: result.resourceId, response: result.response };
}
