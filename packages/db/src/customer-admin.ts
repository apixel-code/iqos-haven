import {
  adminCustomerResponseSchema,
  adminCustomersQuerySchema,
  adminCustomersResponseSchema,
  orderWhatsappResponseSchema,
  type AdminCustomerResponse,
  type AdminCustomersQuery,
  type AdminCustomersResponse,
  type OrderWhatsappResponse,
} from "@ih/contracts";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  fils,
  formatAed,
  formatOrderNumber,
  renderWhatsappTemplate,
  whatsappMessageHref,
  type WhatsappTemplateKind,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";

/**
 * Admin customer views (roadmap step 90, ADR 0058). Customers have no accounts: each is a
 * phone number with the orders placed under it. Staff with `customers.read` see the
 * operational record (contact, addresses, orders); spend is shown only with
 * `customers.financial_read`, in two labelled bases. Read-only.
 */
export class CustomerReadForbiddenError extends Error {}
export class AdminCustomerNotFoundError extends Error {}
export class CustomerCursorError extends Error {}

async function access(db: Database | Tx, actorId: string) {
  const [row] = await db.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
    SELECT coalesce(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
    FROM staff_users u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id
    LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE u.id=${actorId}::uuid AND u.active GROUP BY u.id`);
  const held = row?.permissions ?? [];
  if (!held.includes("customers.read")) throw new CustomerReadForbiddenError();
  return {
    financial: held.includes("customers.financial_read"),
    orders: held.includes("orders.read"),
  };
}
const escapedLike = (value: string) => "%" + value.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
// Spend bases: booked = not cancelled; delivered = Delivered. Integer fils from the database.
const SPEND = Prisma.sql`
  coalesce(sum(o.total_fils) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint AS "bookedFils",
  coalesce(sum(o.total_fils) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS "deliveredFils"`;

interface ListRow {
  id: string;
  name: string;
  phone: string;
  noShow: boolean;
  orderCount: number;
  lastOrderAt: Date | null;
  areaName: string | null;
  bookedFils: bigint;
  deliveredFils: bigint;
  cursor: string;
}

/** Customers who have ordered, newest customer first, by keyset. */
export async function listAdminCustomers(
  db: Database,
  actorId: string,
  input: AdminCustomersQuery,
): Promise<AdminCustomersResponse> {
  const query = adminCustomersQuerySchema.parse(input);
  const rights = await access(db, actorId);
  const filters: Prisma.Sql[] = [Prisma.sql`c.first_order_at IS NOT NULL`];
  if (query.q) {
    // Typed as "050 123…" or "+971 50 123…": compare the digits after any leading zeros.
    const digits = query.q.replace(/\D/g, "").replace(/^0+/, "");
    // Phone search needs at least three digits, so one digit cannot list everyone.
    filters.push(Prisma.sql`(c.display_name ILIKE ${escapedLike(query.q)} ESCAPE '\\'
      OR (${digits.length >= 3} AND c.phone_e164 LIKE ${"%" + digits + "%"}))`);
  }
  if (query.after) {
    let after: [string, string];
    try {
      after = JSON.parse(Buffer.from(query.after, "base64url").toString("utf8")) as [
        string,
        string,
      ];
      if (
        !Array.isArray(after) ||
        !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(after[0]) ||
        !/^[0-9a-f-]{36}$/i.test(after[1])
      )
        throw new Error("shape");
    } catch {
      throw new CustomerCursorError();
    }
    filters.push(Prisma.sql`(c.created_at, c.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  }
  // The page of customers first (index on created_at, id), then their orders only.
  const rows = await db.$queryRaw<ListRow[]>(Prisma.sql`
    WITH page AS (
      SELECT c.id, c.display_name, c.phone_e164, c.no_show, c.created_at
      FROM customers c
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${query.limit + 1})
    SELECT p.id, p.display_name AS name, p.phone_e164 AS phone, p.no_show AS "noShow",
      count(o.id)::int AS "orderCount", max(o.created_at) AS "lastOrderAt",
      (SELECT l.area_name FROM orders l WHERE l.customer_id=p.id
        ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS "areaName",
      ${SPEND},
      -- The cursor is written in UTC whatever the session's time zone.
      to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS cursor
    FROM page p LEFT JOIN orders o ON o.customer_id=p.id
    GROUP BY p.id, p.display_name, p.phone_e164, p.no_show, p.created_at
    ORDER BY p.created_at DESC, p.id DESC`);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return adminCustomersResponseSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      orderCount: row.orderCount,
      lastOrderAt: row.lastOrderAt?.toISOString() ?? null,
      areaName: row.areaName,
      noShow: row.noShow,
      ...(rights.financial
        ? {
            spend: { bookedFils: Number(row.bookedFils), deliveredFils: Number(row.deliveredFils) },
          }
        : {}),
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify([last.cursor, last.id])).toString("base64url")
        : null,
  });
}

export async function readAdminCustomer(
  db: Database,
  actorId: string,
  customerId: string,
): Promise<AdminCustomerResponse> {
  return db.$transaction(
    async (tx) => {
      const rights = await access(tx as unknown as Tx, actorId);
      const [customer] = await tx.$queryRaw<
        Array<{
          id: string;
          name: string;
          phone: string;
          noShow: boolean;
          createdAt: Date;
          firstOrderAt: Date | null;
          lastOrderAt: Date | null;
          orderCount: number;
          cancelledCount: number;
          bookedFils: bigint;
          deliveredFils: bigint;
        }>
      >(Prisma.sql`
        SELECT c.id, c.display_name AS name, c.phone_e164 AS phone, c.no_show AS "noShow",
          c.created_at AS "createdAt", c.first_order_at AS "firstOrderAt",
          max(o.created_at) AS "lastOrderAt", count(o.id)::int AS "orderCount",
          count(o.id) FILTER (WHERE o.status='cancelled')::int AS "cancelledCount", ${SPEND}
        FROM customers c LEFT JOIN orders o ON o.customer_id=c.id
        WHERE c.id=${customerId}::uuid GROUP BY c.id`);
      if (!customer) throw new AdminCustomerNotFoundError();
      const addresses = await tx.$queryRaw<
        Array<{
          id: string;
          areaName: string;
          emirate: string;
          type: "apartment" | "villa" | "office";
          building: string;
          unit: string | null;
          street: string | null;
          makani: string | null;
          notes: string | null;
          createdAt: Date;
        }>
      >(Prisma.sql`
        SELECT a.id, d.name AS "areaName", d.emirate, a.type, a.building, a.unit, a.street,
          a.makani, a.notes, a.created_at AS "createdAt"
        FROM customer_addresses a JOIN delivery_areas d ON d.id=a.area_id
        WHERE a.customer_id=${customerId}::uuid
        ORDER BY a.created_at DESC, a.id DESC LIMIT 10`);
      const orders = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          status: string;
          codStatus: string;
          totalFils: bigint;
          createdAt: Date;
        }>
      >(Prisma.sql`
        SELECT id, order_number::text AS "orderNumber", status, cod_status AS "codStatus",
          total_fils AS "totalFils", created_at AS "createdAt"
        FROM orders WHERE customer_id=${customerId}::uuid
        ORDER BY created_at DESC, id DESC LIMIT 50`);
      return adminCustomerResponseSchema.parse({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        noShow: customer.noShow,
        createdAt: customer.createdAt.toISOString(),
        firstOrderAt: customer.firstOrderAt?.toISOString() ?? null,
        lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
        orderCount: customer.orderCount,
        cancelledCount: customer.cancelledCount,
        addresses: addresses.map((address) => ({
          ...address,
          createdAt: address.createdAt.toISOString(),
        })),
        // Order history needs the order permission as well.
        orders: rights.orders
          ? orders.map((order) => ({
              id: order.id,
              orderNumber: formatOrderNumber(order.orderNumber),
              status: order.status,
              codStatus: order.codStatus,
              totalFils: Number(order.totalFils),
              createdAt: order.createdAt.toISOString(),
            }))
          : [],
        ...(rights.financial
          ? {
              spend: {
                bookedFils: Number(customer.bookedFils),
                deliveredFils: Number(customer.deliveredFils),
              },
            }
          : {}),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

const STATUS_TEXT: Record<string, string> = {
  pending: "received",
  confirmed: "confirmed",
  processing: "being prepared",
  out_for_delivery: "out for delivery",
  delivered: "delivered",
  cancelled: "cancelled",
};
/**
 * The order's WhatsApp messages for staff, from the Owner's templates (or the built-in
 * placeholder wording until BI-09) and the order's own number, status and total. Needs
 * `orders.read` and `customers.read`: the link carries the customer's number.
 */
export async function orderWhatsappLinks(
  db: Database,
  actorId: string,
  orderId: string,
): Promise<OrderWhatsappResponse> {
  const rights = await access(db, actorId);
  if (!rights.orders) throw new CustomerReadForbiddenError();
  const [order] = await db.$queryRaw<
    Array<{ orderNumber: string; status: string; totalFils: bigint; phone: string }>
  >(Prisma.sql`
    SELECT order_number::text AS "orderNumber", status, total_fils AS "totalFils",
      customer_phone_e164 AS phone FROM orders WHERE id=${orderId}::uuid`);
  if (!order) throw new AdminCustomerNotFoundError();
  const settings = await db.$queryRaw<Array<{ key: string; value: Record<string, unknown> }>>(
    Prisma.sql`SELECT key, value FROM settings WHERE key IN ('store','whatsapp')`,
  );
  const store = settings.find((row) => row.key === "store")?.value;
  const whatsapp = settings.find((row) => row.key === "whatsapp")?.value as
    { number?: string | null; templates?: Partial<Record<string, string | null>> } | undefined;
  const values = {
    store_name: typeof store?.name === "string" ? store.name : "Iqos Haven",
    order_number: formatOrderNumber(order.orderNumber),
    status: STATUS_TEXT[order.status] ?? order.status,
    total: formatAed(fils(Number(order.totalFils))),
    support_phone: typeof whatsapp?.number === "string" ? whatsapp.number : "",
  };
  const links = (["orderConfirmation", "statusUpdate"] as WhatsappTemplateKind[]).flatMap(
    (kind) => {
      const own = whatsapp?.templates?.[kind];
      // A template is at most 2000 characters; filled in, it is kept to that too.
      const text = renderWhatsappTemplate(own ?? DEFAULT_WHATSAPP_TEMPLATES[kind], values)
        .slice(0, 2000)
        .trim();
      const href = whatsappMessageHref(order.phone, text);
      return href ? [{ kind, href, text, placeholder: !own }] : [];
    },
  );
  return orderWhatsappResponseSchema.parse({ phone: order.phone, links });
}
