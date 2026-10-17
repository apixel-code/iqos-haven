import type { ReportParams } from "@ih/contracts";
import {
  aedAmount,
  averageFils,
  daysBetween,
  dubaiDate,
  dubaiDateTime,
  dubaiDayRange,
  formatOrderNumber,
  percentAmount,
  rateBps,
  type CsvValue,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";

/**
 * The five CSV reports (roadmap step 111, ADR 0077; architecture §14). Each yields its header
 * row, then data rows, read in keyset batches so a large report (a file, step 112) never holds
 * everything in memory. Run inside one repeatable-read snapshot so the rows agree with each
 * other. Every column says its date basis; amounts are AED from integer fils; times are Dubai.
 */
const BATCH = 1000;
/** Keyset cursor value of a timestamp at full (microsecond) precision; a JS Date keeps only ms. */
const exactTime = (column: string) =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const ORDER_STATUS: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const COD_STATUS: Record<string, string> = {
  pending: "Cash pending",
  collected: "Cash collected",
  not_collected: "Not collected",
};
type Db = Database | Tx;
type Rows = AsyncGenerator<CsvValue[], void, undefined>;

/** File name: report, basis and range (or the snapshot day), e.g. `iqos-haven-sales-booked-…`. */
export function reportFileName(report: ReportParams, asOf: Date): string {
  const span = "from" in report ? `${report.from}-to-${report.to}` : `as-of-${dubaiDate(asOf)}`;
  const basis = report.type === "sales" ? `-${report.basis}` : "";
  return `iqos-haven-${report.type}${basis}-${span}.csv`;
}

export function reportRows(
  db: Db,
  report: ReportParams,
  asOf: Date,
  /** Tests only: a smaller batch, to cross many batch boundaries with few rows. */
  batch = BATCH,
): Rows {
  switch (report.type) {
    case "sales":
      return salesRows(db, report);
    case "orders":
      return orderRows(db, report.from, report.to, batch);
    case "products":
      return productRows(db, report.from, report.to);
    case "inventory":
      return inventoryRows(db, asOf, batch);
    case "customers":
      return customerRows(db, asOf, batch);
  }
}

/**
 * Sales per Dubai day from the daily table, on the chosen basis. A day not computed yet is a
 * row that says so, with no figures (never zeros).
 */
async function* salesRows(db: Db, report: Extract<ReportParams, { type: "sales" }>): Rows {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, placed_orders, cancelled_orders, booked_orders,
      booked_net_fils, booked_delivery_fils, booked_total_fils, delivered_orders,
      delivered_net_fils, delivered_delivery_fils, delivered_total_fils, collected_orders,
      collected_fils, computed_at
    FROM sales_daily WHERE day BETWEEN ${report.from}::date AND ${report.to}::date`);
  const byDay = new Map(rows.map((row) => [row.day as string, row]));
  const n = (row: Record<string, unknown>, key: string) => Number(row[key]);
  const f = (row: Record<string, unknown>, key: string) => BigInt(row[key] as bigint);
  if (report.basis === "booked") {
    yield [
      "Date (Dubai, order placed)",
      "Placed orders",
      "Cancelled orders",
      "Booked orders (not cancelled)",
      "Merchandise net (AED)",
      "Delivery (AED)",
      "Booked total (AED)",
      "Average order value (AED)",
      "Cancellation rate (%)",
      "Computed at (Dubai)",
    ];
    for (const day of daysBetween(report.from, report.to)) {
      const row = byDay.get(day);
      if (!row) {
        yield [day, null, null, null, null, null, null, null, null, "not computed"];
        continue;
      }
      const average = averageFils(f(row, "booked_total_fils"), n(row, "booked_orders"));
      yield [
        day,
        n(row, "placed_orders"),
        n(row, "cancelled_orders"),
        n(row, "booked_orders"),
        aedAmount(f(row, "booked_net_fils")),
        aedAmount(f(row, "booked_delivery_fils")),
        aedAmount(f(row, "booked_total_fils")),
        average === null ? null : aedAmount(average),
        percentAmount(rateBps(n(row, "cancelled_orders"), n(row, "placed_orders"))),
        dubaiDateTime(row.computed_at as Date),
      ];
    }
    return;
  }
  if (report.basis === "delivered") {
    yield [
      "Date (Dubai, delivered)",
      "Delivered orders",
      "Merchandise net (AED)",
      "Delivery (AED)",
      "Delivered total (AED)",
      "Average order value (AED)",
      "Computed at (Dubai)",
    ];
    for (const day of daysBetween(report.from, report.to)) {
      const row = byDay.get(day);
      if (!row) {
        yield [day, null, null, null, null, null, "not computed"];
        continue;
      }
      const average = averageFils(f(row, "delivered_total_fils"), n(row, "delivered_orders"));
      yield [
        day,
        n(row, "delivered_orders"),
        aedAmount(f(row, "delivered_net_fils")),
        aedAmount(f(row, "delivered_delivery_fils")),
        aedAmount(f(row, "delivered_total_fils")),
        average === null ? null : aedAmount(average),
        dubaiDateTime(row.computed_at as Date),
      ];
    }
    return;
  }
  yield [
    "Date (Dubai, cash collected)",
    "Orders collected",
    "Cash collected (AED)",
    "Average per order (AED)",
    "Computed at (Dubai)",
  ];
  for (const day of daysBetween(report.from, report.to)) {
    const row = byDay.get(day);
    if (!row) {
      yield [day, null, null, null, "not computed"];
      continue;
    }
    const average = averageFils(f(row, "collected_fils"), n(row, "collected_orders"));
    yield [
      day,
      n(row, "collected_orders"),
      aedAmount(f(row, "collected_fils")),
      average === null ? null : aedAmount(average),
      dubaiDateTime(row.computed_at as Date),
    ];
  }
}

/**
 * One row per order line for orders placed in the range, with the order's snapshots and its
 * current status. Holds the customer's name and phone (personal data); no address beyond the area.
 */
async function* orderRows(db: Db, from: string, to: string, batch: number): Rows {
  const { start, end } = dubaiDayRange(from, to);
  yield [
    "Order",
    "Placed at (Dubai)",
    "Status now",
    "Source",
    "Customer",
    "Phone",
    "Area",
    "Emirate",
    "Product (as sold)",
    "Brand (as sold)",
    "Category (as sold)",
    "SKU",
    "Quantity",
    "Unit price (AED)",
    "Line discount (AED)",
    "Line total (AED)",
    "Order merchandise (AED)",
    "Order discount (AED)",
    "Delivery fee (AED)",
    "Order total (AED)",
    "Coupon",
    "Payment",
    "Cash",
  ];
  let after: [string, string, string] | null = null;
  for (;;) {
    const keyset: Prisma.Sql = after
      ? Prisma.sql`AND (o.created_at, o.id, i.id) > (${after[0]}::timestamptz, ${after[1]}::uuid, ${after[2]}::uuid)`
      : Prisma.empty;
    const rows = await db.$queryRaw<
      Array<{
        orderId: string;
        itemId: string;
        cursor: string;
        orderNumber: string;
        createdAt: Date;
        status: string;
        source: string;
        customerName: string;
        phone: string;
        areaName: string;
        emirate: string;
        productName: string;
        brandName: string;
        categoryName: string;
        sku: string;
        quantity: number;
        unitPrice: bigint;
        lineDiscount: bigint;
        lineTotal: bigint;
        merchandise: bigint;
        discount: bigint;
        delivery: bigint;
        total: bigint;
        coupon: string | null;
        cod: string;
      }>
    >(Prisma.sql`
      SELECT o.id AS "orderId", i.id AS "itemId", ${exactTime("o.created_at")} AS cursor,
        o.order_number::text AS "orderNumber",
        o.created_at AS "createdAt", o.status, o.source, o.customer_name AS "customerName",
        o.customer_phone_e164 AS phone, o.area_name AS "areaName", o.area_emirate AS emirate,
        i.product_name AS "productName", i.brand_name AS "brandName",
        i.category_name AS "categoryName", i.sku, i.quantity, i.unit_price_fils AS "unitPrice",
        i.discount_fils AS "lineDiscount", i.total_fils AS "lineTotal",
        o.merchandise_subtotal_fils AS merchandise, o.discount_fils AS discount,
        o.delivery_fee_fils AS delivery, o.total_fils AS total, o.coupon_code AS coupon,
        o.cod_status AS cod
      FROM orders o JOIN order_items i ON i.order_id=o.id
      WHERE o.created_at >= ${start}::timestamptz AND o.created_at < ${end}::timestamptz ${keyset}
      ORDER BY o.created_at, o.id, i.id LIMIT ${batch}`);
    for (const row of rows)
      yield [
        formatOrderNumber(row.orderNumber),
        dubaiDateTime(row.createdAt),
        ORDER_STATUS[row.status] ?? row.status,
        row.source === "manual" ? "Staff entered" : "Online store",
        row.customerName,
        row.phone,
        row.areaName,
        row.emirate,
        row.productName,
        row.brandName,
        row.categoryName,
        row.sku,
        row.quantity,
        aedAmount(row.unitPrice),
        aedAmount(row.lineDiscount),
        aedAmount(row.lineTotal),
        aedAmount(row.merchandise),
        aedAmount(row.discount),
        aedAmount(row.delivery),
        aedAmount(row.total),
        row.coupon,
        "Cash on delivery",
        COD_STATUS[row.cod] ?? row.cod,
      ];
    if (rows.length < batch) return;
    const last = rows.at(-1)!;
    after = [last.cursor, last.orderId, last.itemId];
  }
}

/**
 * Per product, brand and category as sold: what was delivered in the range (by delivery day).
 * Net is the line total after discounts. Read from the orders themselves, not the daily table,
 * so it also counts the orders in each row.
 */
async function* productRows(db: Db, from: string, to: string): Rows {
  const { start, end } = dubaiDayRange(from, to);
  yield [
    "Product (as sold)",
    "Brand (as sold)",
    "Category (as sold)",
    "Units delivered",
    "Orders",
    "Discount (AED)",
    "Net sales (AED)",
  ];
  const rows = await db.$queryRaw<
    Array<{
      name: string;
      brandName: string;
      categoryName: string;
      units: number;
      orders: number;
      discount: bigint;
      net: bigint;
    }>
  >(Prisma.sql`
    SELECT max(i.product_name) AS name, i.brand_name AS "brandName",
      i.category_name AS "categoryName", sum(i.quantity)::int AS units,
      count(DISTINCT o.id)::int AS orders, sum(i.discount_fils)::bigint AS discount,
      sum(i.total_fils)::bigint AS net
    FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.status='delivered' AND o.delivered_at >= ${start}::timestamptz
      AND o.delivered_at < ${end}::timestamptz
    GROUP BY i.product_id, i.brand_name, i.category_name
    ORDER BY net DESC, units DESC, name`);
  for (const row of rows)
    yield [
      row.name,
      row.brandName,
      row.categoryName,
      row.units,
      row.orders,
      aedAmount(row.discount),
      aedAmount(row.net),
    ];
}

/** Current stock of every variant of products not in the bin, with the snapshot time. */
async function* inventoryRows(db: Db, asOf: Date, batch: number): Rows {
  yield [
    "Product",
    "Brand",
    "SKU",
    "Product status",
    "Variant active",
    "Stock",
    "Alert level",
    "Stock state",
    "Product stock (all active variants)",
    "Snapshot at (Dubai)",
  ];
  const snapshot = dubaiDateTime(asOf);
  let after: [string, string, string] | null = null;
  for (;;) {
    const keyset: Prisma.Sql = after
      ? Prisma.sql`AND (p.name, v.sku, v.id) > (${after[0]}, ${after[1]}, ${after[2]}::uuid)`
      : Prisma.empty;
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        name: string;
        brand: string;
        sku: string;
        status: string;
        active: boolean;
        stock: number;
        threshold: number;
        productStock: number;
      }>
    >(Prisma.sql`
      SELECT v.id, p.name, b.name AS brand, v.sku, p.status, v.active, v.stock_on_hand AS stock,
        v.low_stock_threshold AS threshold,
        (SELECT coalesce(sum(x.stock_on_hand), 0)::int FROM variants x
          WHERE x.product_id=p.id AND x.active) AS "productStock"
      FROM variants v JOIN products p ON p.id=v.product_id JOIN brands b ON b.id=p.brand_id
      WHERE p.deleted_at IS NULL ${keyset}
      ORDER BY p.name, v.sku, v.id LIMIT ${batch}`);
    for (const row of rows)
      yield [
        row.name,
        row.brand,
        row.sku,
        row.status === "published" ? "Published" : row.status === "draft" ? "Draft" : row.status,
        row.active ? "Yes" : "No",
        row.stock,
        row.threshold,
        row.stock <= 0 ? "Out of stock" : row.stock <= row.threshold ? "Low stock" : "In stock",
        row.productStock,
        snapshot,
      ];
    if (rows.length < batch) return;
    const last = rows.at(-1)!;
    after = [last.name, last.sku, last.id];
  }
}

/**
 * Customers who ordered, grouped by phone (one customer per phone), with order counts and the
 * two spend bases kept apart. Personal data: name and phone.
 */
async function* customerRows(db: Db, asOf: Date, batch: number): Rows {
  yield [
    "Customer",
    "Phone",
    "Orders placed",
    "Orders cancelled",
    "Booked spend (AED, not cancelled)",
    "Delivered spend (AED)",
    "First order (Dubai)",
    "Last order (Dubai)",
    "Areas",
    "Snapshot at (Dubai)",
  ];
  const snapshot = dubaiDateTime(asOf);
  let after: [string, string] | null = null;
  for (;;) {
    const keyset: Prisma.Sql = after
      ? Prisma.sql`AND (c.created_at, c.id) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
      : Prisma.empty;
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        cursor: string;
        name: string;
        phone: string;
        placed: number;
        cancelled: number;
        booked: bigint;
        delivered: bigint;
        first: Date;
        last: Date;
        areas: string;
      }>
    >(Prisma.sql`
      SELECT c.id, ${exactTime("c.created_at")} AS cursor, c.display_name AS name, c.phone_e164 AS phone,
        s.placed, s.cancelled, s.booked, s.delivered, s.first, s.last, s.areas
      FROM customers c
      JOIN LATERAL (
        SELECT count(*)::int AS placed,
          count(*) FILTER (WHERE o.status='cancelled')::int AS cancelled,
          coalesce(sum(o.total_fils) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint AS booked,
          coalesce(sum(o.total_fils) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS delivered,
          min(o.created_at) AS first, max(o.created_at) AS last,
          string_agg(DISTINCT o.area_name, '; ' ORDER BY o.area_name) AS areas
        FROM orders o WHERE o.customer_id=c.id) s ON s.placed > 0
      WHERE c.first_order_at IS NOT NULL ${keyset}
      ORDER BY c.created_at, c.id LIMIT ${batch}`);
    for (const row of rows)
      yield [
        row.name,
        row.phone,
        row.placed,
        row.cancelled,
        aedAmount(row.booked),
        aedAmount(row.delivered),
        dubaiDateTime(row.first),
        dubaiDateTime(row.last),
        row.areas,
        snapshot,
      ];
    if (rows.length < batch) return;
    const last = rows.at(-1)!;
    after = [last.cursor, last.id];
  }
}
