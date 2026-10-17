import {
  defineEvent,
  orderEditDiffSchema,
  orderEditRequestSchema,
  orderEditResponseSchema,
  type ConflictCode,
  type OrderEditDiff,
  type OrderEditRequest,
  type OrderEditResponse,
} from "@ih/contracts";
import { isEditable, type OrderStatus } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { redeemCoupon } from "./coupons";
import { lockExistingOrderCustomer, saveCustomerAddress } from "./customers";
import { canonicalPayloadHash } from "./idempotency";
import { publishLowStockCrossing } from "./inventory";
import { lockOrder, lockVariantsForStock, OrderNotFoundError } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { lockQuoteForOrderEdit, quoteChargeFacts } from "./quote";
import { TransactionRestartError, withTransaction } from "./transaction";

export class OrderEditForbiddenError extends Error {}
export class OrderEditNotFoundError extends Error {}
export class OrderEditConflictError extends Error {
  constructor(
    readonly reason: Extract<
      ConflictCode,
      | "VERSION_CONFLICT"
      | "COMMAND_REUSED"
      | "ORDER_NOT_EDITABLE"
      | "NO_CHANGES"
      | "INSUFFICIENT_STOCK"
    >,
  ) {
    super(reason);
  }
}

interface EditRow {
  id: string;
  orderId: string;
  actorId: string;
  actorName: string;
  commandId: string;
  requestHash: Buffer;
  orderVersion: number;
  diff: OrderEditDiff;
  createdAt: Date;
}
const rowReceipt = (row: EditRow, replayed: boolean): OrderEditResponse =>
  orderEditResponseSchema.parse({
    id: row.id,
    orderId: row.orderId,
    orderVersion: row.orderVersion,
    actor: { id: row.actorId, name: row.actorName },
    editedAt: row.createdAt.toISOString(),
    diff: row.diff,
    replayed,
  });
async function existing(tx: Database | Tx, commandId: string) {
  const [row] = await tx.$queryRaw<EditRow[]>(Prisma.sql`
    SELECT e.id,e.order_id AS "orderId",e.actor_id AS "actorId",u.name AS "actorName",
      e.command_id AS "commandId",e.request_hash AS "requestHash",e.order_version AS "orderVersion",
      e.diff,e.created_at AS "createdAt" FROM order_edit_history e
    JOIN staff_users u ON u.id=e.actor_id WHERE e.command_id=${commandId}::uuid`);
  return row ?? null;
}
function same(row: EditRow, actorId: string | null, orderId: string, hash: Buffer) {
  return (
    row.actorId === actorId && row.orderId === orderId && Buffer.from(row.requestHash).equals(hash)
  );
}
function dbCode(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}
interface CurrentLine {
  id: string;
  variantId: string;
  sku: string;
  quantity: number;
  unitPriceFils: number;
}
interface Snapshot {
  variantId: string;
  productId: string;
  sku: string;
  attributes: unknown;
  productName: string;
  productSlug: string;
  brandName: string;
  categoryName: string;
}

export async function editOrder(
  db: Database,
  context: CommandContext,
  orderId: string,
  request: OrderEditRequest,
): Promise<OrderEditResponse> {
  const input = orderEditRequestSchema.parse(request);
  const hash = canonicalPayloadHash(input);
  const run = () =>
    withTransaction(db, async (tx) => {
      try {
        await lockCatalogueActor(tx, context.actorId, ["orders.edit"], true);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new OrderEditForbiddenError();
        throw error;
      }
      const early = await existing(tx, input.commandId);
      if (early) {
        if (!same(early, context.actorId, orderId, hash))
          throw new OrderEditConflictError("COMMAND_REUSED");
        return rowReceipt(early, true);
      }
      let locked;
      try {
        locked = await lockOrder(tx, orderId);
      } catch (error) {
        if (error instanceof OrderNotFoundError) throw new OrderEditNotFoundError();
        throw error;
      }
      const raced = await existing(tx, input.commandId);
      if (raced) {
        if (!same(raced, context.actorId, orderId, hash))
          throw new OrderEditConflictError("COMMAND_REUSED");
        return rowReceipt(raced, true);
      }
      if (locked.version !== input.expectedVersion)
        throw new OrderEditConflictError("VERSION_CONFLICT");
      const keys = Object.keys(input).filter(
        (key) => !["expectedVersion", "commandId"].includes(key),
      );
      if (locked.status === "processing" && (keys.length !== 1 || keys[0] !== "operationalNote"))
        throw new OrderEditConflictError("ORDER_NOT_EDITABLE");
      if (locked.status !== "processing" && !isEditable(locked.status as OrderStatus))
        throw new OrderEditConflictError("ORDER_NOT_EDITABLE");
      const [current] = await tx.$queryRaw<Array<Record<string, unknown>>>(
        Prisma.sql`SELECT * FROM orders WHERE id=${orderId}::uuid`,
      );
      const currentLines = await tx.$queryRaw<
        CurrentLine[]
      >(Prisma.sql`SELECT id,variant_id AS "variantId",
      sku,quantity,unit_price_fils::int AS "unitPriceFils" FROM order_items
      WHERE order_id=${orderId}::uuid ORDER BY variant_id`);
      const [lastNote] = await tx.$queryRaw<Array<{ note: string | null }>>(Prisma.sql`
      SELECT diff->'operationalNote'->>'after' AS note FROM order_edit_history
      WHERE order_id=${orderId}::uuid AND diff ? 'operationalNote' ORDER BY seq DESC LIMIT 1`);
      const noteBefore = lastNote?.note ?? null;
      const noteAfter = input.operationalNote === undefined ? noteBefore : input.operationalNote;
      const diff: Record<string, unknown> = {};
      const commerce =
        input.lines !== undefined || input.couponCode !== undefined || input.address !== undefined;
      let quote: Awaited<ReturnType<typeof lockQuoteForOrderEdit>> | null = null;
      if (commerce) {
        await lockExistingOrderCustomer(tx, locked.customerId);
        const lines =
          input.lines ?? currentLines.map(({ variantId, quantity }) => ({ variantId, quantity }));
        const address = input.address ?? {
          areaId: current!.area_id as string,
          type: current!.address_type as never,
          building: current!.address_building as string,
          unit: current!.address_unit as string | null,
          street: current!.address_street as string | null,
          makani: current!.address_makani as string | null,
          notes: current!.address_notes as string | null,
        };
        const couponCode =
          input.couponCode === undefined
            ? (current!.coupon_code as string | null)
            : input.couponCode;
        const preservedPrices = new Map(
          currentLines
            .filter((before) =>
              lines.some(
                (after) =>
                  after.variantId === before.variantId && after.quantity === before.quantity,
              ),
            )
            .map((line) => [line.variantId, line.unitPriceFils]),
        );
        quote = await lockQuoteForOrderEdit(
          tx,
          orderId,
          { lines, areaId: address.areaId, couponCode },
          preservedPrices,
        );
        const variants = await lockVariantsForStock(tx, [
          ...new Set([...currentLines.map((l) => l.variantId), ...lines.map((l) => l.variantId)]),
        ]);
        const stocks = new Map(variants.map((v) => [v.variantId, v]));
        if (quote.lines.some((line) => stocks.get(line.variantId)!.version !== line.variantVersion))
          throw new TransactionRestartError("Variant changed while editing an order");
        const oldQty = new Map(currentLines.map((l) => [l.variantId, l.quantity]));
        const newQty = new Map(lines.map((l) => [l.variantId, l.quantity]));
        const short = lines.filter(
          (line) =>
            stocks.get(line.variantId)!.stockOnHand <
            line.quantity - (oldQty.get(line.variantId) ?? 0),
        );
        if (short.length) throw new OrderEditConflictError("INSUFFICIENT_STOCK");
        const snapshots = new Map(
          (
            await tx.$queryRaw<Snapshot[]>(Prisma.sql`
        SELECT v.id AS "variantId",p.id AS "productId",v.sku,v.attributes,p.name AS "productName",
          p.slug AS "productSlug",b.name AS "brandName",c.name AS "categoryName"
        FROM variants v JOIN products p ON p.id=v.product_id JOIN brands b ON b.id=p.brand_id
        JOIN categories c ON c.id=p.category_id WHERE v.id=ANY(${lines.map((l) => l.variantId)}::uuid[])`)
          ).map((s) => [s.variantId, s]),
        );
        for (const variant of variants) {
          const delta = (oldQty.get(variant.variantId) ?? 0) - (newQty.get(variant.variantId) ?? 0);
          if (!delta) continue;
          const after = variant.stockOnHand + delta;
          await tx.$executeRaw(Prisma.sql`INSERT INTO stock_movements
          (variant_id,delta,balance_after,reason,command_id,effect,actor_id,order_id)
          VALUES (${variant.variantId}::uuid,${delta},${after},'ORDER_EDIT',${input.commandId},
            'order_edit',${context.actorId}::uuid,${orderId}::uuid)`);
          await publishLowStockCrossing(
            tx,
            variant.variantId,
            "stock",
            { stock: variant.stockOnHand, threshold: variant.lowStockThreshold },
            { stock: after, threshold: variant.lowStockThreshold },
          );
        }
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM order_items WHERE order_id=${orderId}::uuid AND NOT (variant_id=ANY(${lines.map((l) => l.variantId)}::uuid[]))`,
        );
        for (const line of quote.lines) {
          const snap = snapshots.get(line.variantId)!;
          const before = currentLines.find((entry) => entry.variantId === line.variantId);
          if (before && before.quantity === line.quantity) {
            await tx.$executeRaw(Prisma.sql`UPDATE order_items SET discount_fils=${line.discountFils},
            total_fils=${line.totalFils} WHERE id=${before.id}::uuid`);
          } else
            await tx.$executeRaw(Prisma.sql`INSERT INTO order_items
          (order_id,product_id,variant_id,product_name,product_slug,brand_name,category_name,sku,
           attributes,product_version,variant_version,unit_price_fils,quantity,subtotal_fils,discount_fils,total_fils)
          VALUES (${orderId}::uuid,${line.productId}::uuid,${line.variantId}::uuid,${snap.productName},
           ${snap.productSlug},${snap.brandName},${snap.categoryName},${snap.sku},${JSON.stringify(snap.attributes)}::jsonb,
           ${line.productVersion},${line.variantVersion},${line.unitPriceFils},${line.quantity},${line.subtotalFils},${line.discountFils},${line.totalFils})
          ON CONFLICT (order_id,variant_id) DO UPDATE SET product_name=EXCLUDED.product_name,
           product_slug=EXCLUDED.product_slug,brand_name=EXCLUDED.brand_name,category_name=EXCLUDED.category_name,
           sku=EXCLUDED.sku,attributes=EXCLUDED.attributes,product_version=EXCLUDED.product_version,
           variant_version=EXCLUDED.variant_version,unit_price_fils=EXCLUDED.unit_price_fils,
           quantity=EXCLUDED.quantity,subtotal_fils=EXCLUDED.subtotal_fils,
           discount_fils=EXCLUDED.discount_fils,total_fils=EXCLUDED.total_fils`);
        }
        if (quote.appliedCoupon) await redeemCoupon(tx, orderId, quote.appliedCoupon);
        const addressChanged =
          input.address !== undefined &&
          (address.areaId !== current!.area_id ||
            address.type !== current!.address_type ||
            address.building !== current!.address_building ||
            address.unit !== current!.address_unit ||
            address.street !== current!.address_street ||
            address.makani !== current!.address_makani ||
            address.notes !== current!.address_notes);
        if (addressChanged) await saveCustomerAddress(tx, locked.customerId, address);
        const beforeItems = currentLines.map(({ sku, quantity }) => ({ sku, quantity }));
        const afterItems = lines.map((line) => ({
          sku: snapshots.get(line.variantId)!.sku,
          quantity: line.quantity,
        }));
        if (JSON.stringify(beforeItems) !== JSON.stringify(afterItems))
          diff.items = { before: beforeItems, after: afterItems };
        if (current!.coupon_code !== (quote.coupon?.code ?? null))
          diff.coupon = { before: current!.coupon_code, after: quote.coupon?.code ?? null };
        if (addressChanged)
          diff.delivery = {
            beforeArea: current!.area_name,
            afterArea: quote.delivery.areaName,
            addressChanged: true,
          };
        if (Number(current!.total_fils) !== quote.totalFils)
          diff.total = { beforeFils: Number(current!.total_fils), afterFils: quote.totalFils };
        await tx.$executeRaw(Prisma.sql`UPDATE orders SET area_id=${quote.delivery.areaId}::uuid,
        area_code=${quote.delivery.areaCode},area_name=${quote.delivery.areaName},area_emirate=${quote.delivery.emirate},
        address_type=${address.type},address_building=${address.building},address_unit=${address.unit},
        address_street=${address.street},address_makani=${address.makani},address_notes=${address.notes},
        merchandise_subtotal_fils=${quote.merchandiseSubtotalFils},discount_fils=${quote.discountFils},
        delivery_fee_fils=${quote.deliveryFeeFils},total_fils=${quote.totalFils},coupon_code=${quote.coupon?.code ?? null},
        coupon_percent_bps=${quote.coupon?.percentBps ?? null}::int,delivery_eta_text=${quote.delivery.etaText},
        area_version=${quote.delivery.areaVersion},delivery_configuration_version=${quote.delivery.configurationVersion},
        quote_fingerprint=${canonicalPayloadHash(quoteChargeFacts(quote)).toString("base64url")},
        version=version+1,updated_at=statement_timestamp() WHERE id=${orderId}::uuid`);
      } else {
        await tx.$executeRaw(
          Prisma.sql`UPDATE orders SET version=version+1,updated_at=statement_timestamp() WHERE id=${orderId}::uuid`,
        );
      }
      if (noteAfter !== noteBefore) diff.operationalNote = { before: noteBefore, after: noteAfter };
      if (!Object.keys(diff).length) throw new OrderEditConflictError("NO_CHANGES");
      const parsedDiff = orderEditDiffSchema.parse(diff);
      const version = locked.version + 1;
      const [row] = await tx.$queryRaw<EditRow[]>(Prisma.sql`WITH inserted AS (
      INSERT INTO order_edit_history(order_id,actor_id,command_id,request_hash,order_version,diff)
      VALUES (${orderId}::uuid,${context.actorId}::uuid,${input.commandId}::uuid,${hash},${version},${JSON.stringify(parsedDiff)}::jsonb)
      RETURNING *) SELECT i.id,i.order_id AS "orderId",i.actor_id AS "actorId",u.name AS "actorName",
      i.command_id AS "commandId",i.request_hash AS "requestHash",i.order_version AS "orderVersion",
      i.diff,i.created_at AS "createdAt" FROM inserted i JOIN staff_users u ON u.id=i.actor_id`);
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(
          { ...context, commandId: input.commandId },
          {
            action: "order.edited",
            entity: { type: "order", id: orderId },
            before: { version: locked.version },
            after: { version, fields: Object.keys(parsedDiff) },
          },
        ),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("order.updated", orderId, { orderId }, version),
      );
      return rowReceipt(row!, false);
    });
  try {
    return await run();
  } catch (error) {
    if (dbCode(error) !== "23505") throw error;
    const winner = await existing(db, input.commandId);
    if (!winner || !same(winner, context.actorId, orderId, hash))
      throw new OrderEditConflictError("COMMAND_REUSED");
    return rowReceipt(winner, true);
  }
}
