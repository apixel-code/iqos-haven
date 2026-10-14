import {
  adminOrderResponseSchema,
  adminOrdersQuerySchema,
  adminOrdersResponseSchema,
  type AdminOrderResponse,
  type AdminOrdersQuery,
} from "@ih/contracts";
import { formatOrderNumber, parseOrderNumber } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";

export class OrderReadForbiddenError extends Error {}
export class AdminOrderNotFoundError extends Error {}
export class OrderCursorError extends Error {}

interface ActorAccess {
  canReadContact: boolean;
  canEdit: boolean;
}
interface OrderListRow {
  id: string;
  orderNumber: bigint;
  status: string;
  source: string;
  customerName: string;
  customerPhone: string;
  itemCount: number;
  areaName: string;
  totalFils: bigint;
  codStatus: string;
  version: number;
  createdAt: Date;
  cursorCreatedAt: string;
}

async function actorAccess(db: Database | Tx, actorId: string): Promise<ActorAccess> {
  const [row] = await db.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
    SELECT coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}')
      AS permissions
    FROM staff_users u
    JOIN roles r ON r.id=u.role_id
    LEFT JOIN role_permissions rp ON rp.role_id=r.id
    LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE u.id=${actorId}::uuid AND u.active
    GROUP BY u.id`);
  if (!row?.permissions.includes("orders.read")) throw new OrderReadForbiddenError();
  return {
    canReadContact: row.permissions.includes("customers.read"),
    canEdit: row.permissions.includes("orders.edit"),
  };
}

const escapedLike = (value: string) => "%" + value.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const encodeCursor = (row: OrderListRow) =>
  Buffer.from(JSON.stringify([row.cursorCreatedAt, row.id])).toString("base64url");

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed[1])
    )
      throw new Error("shape");
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new OrderCursorError();
  }
}

export async function listAdminOrders(db: Database, actorId: string, input: AdminOrdersQuery) {
  const query = adminOrdersQuerySchema.parse(input);
  const access = await actorAccess(db, actorId);
  const filters: Prisma.Sql[] = [];
  if (query.status) filters.push(Prisma.sql`o.status=${query.status}`);
  if (query.from) filters.push(Prisma.sql`o.created_at>=${new Date(query.from)}`);
  if (query.to) filters.push(Prisma.sql`o.created_at<${new Date(query.to)}`);
  if (query.q) {
    const orderNumber = parseOrderNumber(query.q);
    const digits = query.q.replace(/\D/g, "");
    const contact = access.canReadContact
      ? Prisma.sql`o.customer_name ILIKE ${escapedLike(query.q)} ESCAPE '\\'
          OR (${digits.length > 0} AND regexp_replace(o.customer_phone_e164, '\\D', '', 'g')
            LIKE ${"%" + digits + "%"})`
      : Prisma.sql`false`;
    filters.push(
      Prisma.sql`(${orderNumber === null ? Prisma.sql`false` : Prisma.sql`o.order_number=${orderNumber}`} OR ${contact})`,
    );
  }
  if (query.after) {
    const after = decodeCursor(query.after);
    filters.push(
      Prisma.sql`(o.created_at,o.id)<(${after.createdAt}::timestamptz,${after.id}::uuid)`,
    );
  }
  const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
  const rows = await db.$queryRaw<OrderListRow[]>(Prisma.sql`
    SELECT o.id, o.order_number AS "orderNumber", o.status, o.source,
      o.customer_name AS "customerName", o.customer_phone_e164 AS "customerPhone",
      sum(i.quantity)::int AS "itemCount", o.area_name AS "areaName",
      o.total_fils AS "totalFils", o.cod_status AS "codStatus", o.version,
      o.created_at AS "createdAt", o.created_at::text AS "cursorCreatedAt"
    FROM orders o JOIN order_items i ON i.order_id=o.id
    ${where}
    GROUP BY o.id
    ORDER BY o.created_at DESC,o.id DESC
    LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit);
  return adminOrdersResponseSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      orderNumber: formatOrderNumber(row.orderNumber),
      status: row.status,
      source: row.source,
      ...(access.canReadContact
        ? { customer: { name: row.customerName, phone: row.customerPhone } }
        : {}),
      itemCount: row.itemCount,
      areaName: row.areaName,
      totalFils: Number(row.totalFils),
      codStatus: row.codStatus,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > query.limit && page.length ? encodeCursor(page.at(-1)!) : null,
  });
}

export async function readAdminOrder(
  db: Database,
  actorId: string,
  orderId: string,
): Promise<AdminOrderResponse> {
  return db.$transaction(
    async (tx) => {
      const access = await actorAccess(tx as unknown as Tx, actorId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: { orderBy: { id: "asc" } },
          history: { orderBy: { seq: "asc" }, include: { actor: { select: { name: true } } } },
          edits: { orderBy: { seq: "asc" }, include: { actor: { select: { name: true } } } },
          cancellation: { include: { returnItems: { orderBy: { sku: "asc" } } } },
          collectionRecords: {
            orderBy: { seq: "asc" },
            include: { actor: { select: { name: true } } },
          },
        },
      });
      if (!order) throw new AdminOrderNotFoundError();
      return adminOrderResponseSchema.parse({
        id: order.id,
        orderNumber: formatOrderNumber(order.orderNumber),
        status: order.status,
        source: order.source,
        ...(access.canReadContact
          ? {
              customer: {
                name: order.customerName,
                phone: order.customerPhoneE164,
                address: {
                  type: order.addressType,
                  building: order.addressBuilding,
                  unit: order.addressUnit,
                  street: order.addressStreet,
                  makani: order.addressMakani,
                  notes: order.addressNotes,
                },
              },
            }
          : {}),
        area: {
          ...(access.canEdit ? { id: order.areaId } : {}),
          code: order.areaCode,
          name: order.areaName,
          emirate: order.areaEmirate,
        },
        merchandiseSubtotalFils: Number(order.merchandiseSubtotalFils),
        discountFils: Number(order.discountFils),
        deliveryFeeFils: Number(order.deliveryFeeFils),
        totalFils: Number(order.totalFils),
        coupon:
          order.couponCode && order.couponPercentBps
            ? { code: order.couponCode, percentBps: order.couponPercentBps }
            : null,
        deliveryEtaText: order.deliveryEtaText,
        codStatus: order.codStatus,
        collectedAmountFils:
          order.collectedAmountFils === null ? null : Number(order.collectedAmountFils),
        collectedAt: order.collectedAt?.toISOString() ?? null,
        collectionReference: order.collectionReference,
        cancelReason: order.cancelReason,
        dispatchedAt: order.dispatchedAt?.toISOString() ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        returnedAt: order.returnedAt?.toISOString() ?? null,
        version: order.version,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        operationalNote:
          [...order.edits]
            .reverse()
            .map((entry) => entry.diff as { operationalNote?: { after?: string | null } })
            .find((diff) => diff.operationalNote !== undefined)?.operationalNote?.after ?? null,
        items: order.items.map((item) => ({
          id: item.id,
          ...(access.canEdit ? { variantId: item.variantId } : {}),
          productName: item.productName,
          productSlug: item.productSlug,
          brandName: item.brandName,
          categoryName: item.categoryName,
          sku: item.sku,
          attributes: item.attributes,
          unitPriceFils: Number(item.unitPriceFils),
          quantity: item.quantity,
          subtotalFils: Number(item.subtotalFils),
          discountFils: Number(item.discountFils),
          totalFils: Number(item.totalFils),
        })),
        history: order.history.map((entry) => ({
          id: entry.id,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          reason: entry.reason,
          actorKind: entry.actorKind,
          actorName: entry.actor?.name ?? null,
          orderVersion: entry.orderVersion,
          createdAt: entry.createdAt.toISOString(),
        })),
        edits: order.edits.map((entry) => ({
          id: entry.id,
          orderVersion: entry.orderVersion,
          actor: { id: entry.actorId, name: entry.actor.name },
          editedAt: entry.createdAt.toISOString(),
          diff: entry.diff,
        })),
        collectionRecords: order.collectionRecords.map((record) => ({
          id: record.id,
          kind: record.kind,
          orderVersion: record.orderVersion,
          amountFils: Number(record.amountFils),
          collectedAt: record.collectedAt.toISOString(),
          reference: record.reference,
          reason: record.reason,
          actor: { id: record.actorId, name: record.actor.name },
          recordedAt: record.createdAt.toISOString(),
        })),
        returnItems: (order.cancellation?.returnItems ?? []).map((item) => ({
          sku: item.sku,
          quantity: item.quantity,
          resellableQuantity: item.resellableQuantity,
          damagedQuantity: item.damagedQuantity,
        })),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
