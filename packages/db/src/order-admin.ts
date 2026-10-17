import {
  adminOrderCountsQuerySchema,
  adminOrderCountsResponseSchema,
  adminOrderResponseSchema,
  adminOrdersQuerySchema,
  adminOrdersResponseSchema,
  type AdminOrderCountsQuery,
  type AdminOrderCountsResponse,
  type AdminOrderResponse,
  type AdminOrderSort,
  type AdminOrdersQuery,
} from "@ih/contracts";
import { formatOrderNumber, parseOrderNumber } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { DELAYED_ORDER } from "./dashboard";

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
/**
 * Keyset per sort (parity G-A5): the cursor names its sort and holds the sort key and the id,
 * so a cursor from another sort is refused rather than misread. A two-part cursor from before
 * the sorts existed is the newest-first one.
 */
const SORT_KEYS: Record<
  AdminOrderSort,
  { column: Prisma.Sql; cast: Prisma.Sql; direction: "ASC" | "DESC" }
> = {
  newest: { column: Prisma.sql`o.created_at`, cast: Prisma.sql`timestamptz`, direction: "DESC" },
  oldest: { column: Prisma.sql`o.created_at`, cast: Prisma.sql`timestamptz`, direction: "ASC" },
  total_desc: { column: Prisma.sql`o.total_fils`, cast: Prisma.sql`bigint`, direction: "DESC" },
  total_asc: { column: Prisma.sql`o.total_fils`, cast: Prisma.sql`bigint`, direction: "ASC" },
};
const TIME_KEY = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/;
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (sort: AdminOrderSort, row: OrderListRow) =>
  Buffer.from(
    JSON.stringify([
      sort,
      sort.startsWith("total") ? String(row.totalFils) : row.cursorCreatedAt,
      row.id,
    ]),
  ).toString("base64url");

function decodeCursor(value: string, sort: AdminOrderSort): { key: string; id: string } {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("shape");
    const [named, key, id] =
      parsed.length === 2 ? ["newest", parsed[0], parsed[1]] : (parsed as unknown[]);
    if (parsed.length !== 2 && parsed.length !== 3) throw new Error("shape");
    if (named !== sort || typeof key !== "string" || typeof id !== "string")
      throw new Error("sort");
    const keyOk = sort.startsWith("total") ? /^\d{1,12}$/.test(key) : TIME_KEY.test(key);
    if (!keyOk || !UUID_KEY.test(id)) throw new Error("shape");
    return { key, id };
  } catch {
    throw new OrderCursorError();
  }
}

/** The list's filters other than status and paging, shared by the list and the tab counts. */
function orderFilters(
  query: {
    delayed?: "true" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    q?: string | undefined;
  },
  access: ActorAccess,
): Prisma.Sql[] {
  const filters: Prisma.Sql[] = [];
  if (query.delayed === "true") filters.push(DELAYED_ORDER);
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
  return filters;
}

export async function listAdminOrders(db: Database, actorId: string, input: AdminOrdersQuery) {
  const query = adminOrdersQuerySchema.parse(input);
  const access = await actorAccess(db, actorId);
  const filters = orderFilters(query, access);
  if (query.status) filters.push(Prisma.sql`o.status=${query.status}`);
  const order = SORT_KEYS[query.sort];
  if (query.after) {
    const after = decodeCursor(query.after, query.sort);
    filters.push(
      order.direction === "DESC"
        ? Prisma.sql`(${order.column},o.id)<(${after.key}::${order.cast},${after.id}::uuid)`
        : Prisma.sql`(${order.column},o.id)>(${after.key}::${order.cast},${after.id}::uuid)`,
    );
  }
  const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
  const rows = await db.$queryRaw<OrderListRow[]>(Prisma.sql`
    SELECT o.id, o.order_number AS "orderNumber", o.status, o.source,
      o.customer_name AS "customerName", o.customer_phone_e164 AS "customerPhone",
      -- Counted per order of the page only (step 121): grouping every order before the LIMIT
      -- made the first page cost grow with the whole order history.
      (SELECT sum(i.quantity)::int FROM order_items i WHERE i.order_id=o.id) AS "itemCount",
      o.area_name AS "areaName",
      o.total_fils AS "totalFils", o.cod_status AS "codStatus", o.version,
      o.created_at AS "createdAt", o.created_at::text AS "cursorCreatedAt"
    FROM orders o
    ${where}
    ORDER BY ${order.column} ${Prisma.raw(order.direction)},o.id ${Prisma.raw(order.direction)}
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
    nextCursor:
      rows.length > query.limit && page.length ? encodeCursor(query.sort, page.at(-1)!) : null,
  });
}

/** Orders per status under the list's other filters (the tab counts, parity G-A5). */
export async function countAdminOrders(
  db: Database,
  actorId: string,
  input: AdminOrderCountsQuery,
): Promise<AdminOrderCountsResponse> {
  const query = adminOrderCountsQuerySchema.parse(input);
  const access = await actorAccess(db, actorId);
  const filters = orderFilters(query, access);
  const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
  const [row] = await db.$queryRaw<
    Array<Record<keyof AdminOrderCountsResponse, number>>
  >(Prisma.sql`
    SELECT count(*)::int AS "all",
      count(*) FILTER (WHERE o.status='pending')::int AS pending,
      count(*) FILTER (WHERE o.status='confirmed')::int AS confirmed,
      count(*) FILTER (WHERE o.status='processing')::int AS processing,
      count(*) FILTER (WHERE o.status='out_for_delivery')::int AS out_for_delivery,
      count(*) FILTER (WHERE o.status='delivered')::int AS delivered,
      count(*) FILTER (WHERE o.status='cancelled')::int AS cancelled
    FROM orders o ${where}`);
  return adminOrderCountsResponseSchema.parse(row);
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
