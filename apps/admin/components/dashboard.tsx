"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminDashboardSchema, type AdminDashboard } from "@ih/contracts";
import { money, ORDER_STATUS_LABELS, when } from "../lib/orders";

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; data: AdminDashboard };
type OrderLine = NonNullable<AdminDashboard["orders"]>["recent"][number];
type SalesDay = NonNullable<AdminDashboard["sales"]>["today"];

const REFRESH_MS = 60_000;
const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
const ago = (iso: string, now: string) => {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
};

/**
 * Operational home (roadmap step 108, ADR 0074). Everything shown comes from
 * `GET /v1/admin/dashboard`; a section the API leaves out (`null`) is not drawn, and nothing is
 * filled in with sample values. Reloaded every minute and on demand.
 */
export function Dashboard() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const refresh = useCallback(() => {
    fetch("/api/v1/admin/dashboard", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setLoad({ state: "ready", data: adminDashboardSchema.parse(await response.json()) });
      })
      .catch(() =>
        setLoad((current) => (current.state === "ready" ? current : { state: "failed" })),
      );
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (load.state === "loading") return <p className="muted">Loading today’s overview…</p>;
  if (load.state === "failed")
    return (
      <div className="notice" role="alert">
        The overview could not be loaded.{" "}
        <button className="text-button" type="button" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  const { data } = load;
  const { orders, stock, reviews, sales, topProducts } = data;
  const attention = [
    orders?.open.pending
      ? { href: "/workspace/orders", text: `${orders.open.pending} pending to confirm` }
      : null,
    orders?.delayed ? { href: "/workspace/orders", text: `${orders.delayed} delayed` } : null,
    stock && stock.low + stock.out
      ? { href: "/workspace/inventory", text: `${stock.low + stock.out} low or out of stock` }
      : null,
    reviews?.pending
      ? { href: "/workspace/reviews", text: `${reviews.pending} reviews to moderate` }
      : null,
  ].filter((item) => item !== null);
  const watched = Boolean(orders || stock || reviews);

  return (
    <div className="dashboard">
      <p className="muted small">
        {dubaiTime(data.generatedAt)} Dubai time ·{" "}
        <button className="text-button" type="button" onClick={refresh}>
          Refresh
        </button>
      </p>
      {watched &&
        (attention.length ? (
          <nav className="attention" aria-label="Needs attention">
            {attention.map((item) => (
              <Link className="attention-item" href={item.href} key={item.text}>
                {item.text}
              </Link>
            ))}
          </nav>
        ) : (
          <p className="notice">
            <b>All caught up.</b> Nothing is waiting in the areas you look after.
          </p>
        ))}

      {orders && (
        <div className="kpi-grid">
          <Kpi
            label="Today’s orders"
            value={orders.placedToday}
            foot={`${orders.placedYesterdaySoFar} by this time yesterday`}
            href="/workspace/orders"
          />
          <Kpi
            label="Pending"
            value={orders.open.pending}
            foot={
              orders.delayed
                ? `${orders.delayed} open orders waiting too long`
                : "Need confirmation"
            }
            href="/workspace/orders"
          />
          <Kpi
            label="Confirmed or processing"
            value={orders.open.confirmed + orders.open.processing}
            foot="Being prepared"
            href="/workspace/orders"
          />
          <Kpi
            label="Out for delivery"
            value={orders.open.outForDelivery}
            foot="With the courier"
            href="/workspace/orders"
          />
        </div>
      )}

      {sales && (
        <section className="management-card" aria-labelledby="sales-title">
          <h2 id="sales-title">Booked sales</h2>
          <div className="kpi-grid">
            <SalesTile label="Today" day={sales.today} />
            <SalesTile label="Yesterday" day={sales.yesterday} />
          </div>
          <p className="muted small">
            Orders placed and not cancelled, by order date (Asia/Dubai), in {sales.currency}.{" "}
            {sales.taxNote}
          </p>
        </section>
      )}

      <div className="dashboard-split">
        {orders && (
          <section className="management-card" aria-labelledby="recent-title">
            <div className="inline-row">
              <h2 id="recent-title">Recent orders</h2>
              <Link href="/workspace/orders">All orders →</Link>
            </div>
            <OrderList lines={orders.recent} now={data.generatedAt} empty="No orders yet." />
          </section>
        )}
        <div className="dashboard-stack">
          {orders && (
            <section className="management-card" aria-labelledby="attention-title">
              <h2 id="attention-title">Needs attention</h2>
              <p className="muted small">
                Oldest first. Delayed: pending over {orders.delayedAfterMinutes.pending / 60} h,
                confirmed or processing over {orders.delayedAfterMinutes.inProgress / 60} h.
              </p>
              <OrderList
                lines={orders.attention}
                now={data.generatedAt}
                empty="Nothing waiting. New orders that need a decision appear here."
              />
            </section>
          )}
          {stock && (
            <section className="management-card" aria-labelledby="stock-title">
              <div className="inline-row">
                <h2 id="stock-title">Low stock</h2>
                <Link href="/workspace/inventory">Inventory →</Link>
              </div>
              {stock.items.length ? (
                <ul className="dashboard-list">
                  {stock.items.map((item) => (
                    <li key={item.variantId}>
                      <b>{item.productName}</b> <span className="muted small">{item.sku}</span>
                      <br />
                      <span className={item.stock <= 0 ? "stock-out" : "stock-low"}>
                        {item.stock <= 0 ? "Out of stock" : `${item.stock} left`}
                      </span>{" "}
                      <span className="muted small">
                        · alert level {item.threshold}
                        {item.stock <= 0 ? " · still visible in the store" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No product on sale is at or below its alert level.</p>
              )}
            </section>
          )}
        </div>
      </div>

      {topProducts && (
        <section className="management-card" aria-labelledby="top-title">
          <h2 id="top-title">Most ordered products</h2>
          <p className="muted small">
            Units in orders placed {topProducts.from} to {topProducts.to} and not cancelled; updated
            every few minutes.
          </p>
          {topProducts.items.length ? (
            <ol className="dashboard-list">
              {topProducts.items.map((item) => (
                <li key={item.productId}>
                  <b>{item.name}</b> · {item.units} {item.units === 1 ? "unit" : "units"}
                  {item.netFils !== null && (
                    <span className="muted small"> · {money(item.netFils)}</span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No orders in the last seven days.</p>
          )}
        </section>
      )}
    </div>
  );
}

function Kpi(props: { label: string; value: number; foot: string; href: string }) {
  return (
    <Link className="kpi" href={props.href}>
      <span className="muted small">{props.label}</span>
      <span className="kpi-value">{props.value.toLocaleString("en-AE")}</span>
      <span className="muted small">{props.foot}</span>
    </Link>
  );
}

function SalesTile({ label, day }: { label: string; day: SalesDay }) {
  if (!day)
    return (
      <div className="kpi">
        <span className="muted small">{label}</span>
        <span className="kpi-value">—</span>
        <span className="muted small">Not computed yet</span>
      </div>
    );
  return (
    <div className="kpi">
      <span className="muted small">{label}</span>
      <span className="kpi-value">{money(day.totalFils)}</span>
      <span className="muted small">
        {day.orders} {day.orders === 1 ? "order" : "orders"}
        {day.aovFils !== null ? ` · average ${money(day.aovFils)}` : ""}
        {day.cancelledOrders ? ` · ${day.cancelledOrders} cancelled` : ""}
      </span>
      <span className="muted small">As of {dubaiTime(day.computedAt)}</span>
    </div>
  );
}

function OrderList({ lines, now, empty }: { lines: OrderLine[]; now: string; empty: string }) {
  if (!lines.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="dashboard-list">
      {lines.map((line) => (
        <li key={line.id}>
          <b>{line.orderNumber}</b>
          {line.customerName ? ` · ${line.customerName}` : ""}{" "}
          <span className={`order-status status-${line.status}`}>
            {ORDER_STATUS_LABELS[line.status] ?? line.status}
          </span>
          <br />
          <span className="muted small">
            {money(line.totalFils)} · placed {ago(line.createdAt, now)} ago ({when(line.createdAt)})
            {line.delayed ? " · " : ""}
          </span>
          {line.delayed && <span className="stock-out small">delayed</span>}
        </li>
      ))}
    </ul>
  );
}
