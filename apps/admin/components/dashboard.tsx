"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { adminDashboardSchema, type AdminDashboard } from "@ih/contracts";
import {
  newOrderHref,
  newProductHref,
  orderHref,
  ordersHref,
  productHref,
  variantStockHref,
} from "../lib/links";
import { Icon, type IconName } from "./icons";
import { useSession } from "./session-shell";
import { money, ORDER_STATUS_LABELS } from "../lib/orders";

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; data: AdminDashboard };
type OrderLine = NonNullable<AdminDashboard["orders"]>["recent"][number];
type SalesDayData = NonNullable<AdminDashboard["sales"]>["today"];

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
  const session = useSession();
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

  if (load.state === "loading") return <p className="muted dash-wait">Loading today’s overview…</p>;
  if (load.state === "failed")
    return (
      <div className="note err" role="alert">
        <Icon name="alert" />
        <p>
          The overview could not be loaded.{" "}
          <button className="link-btn" type="button" onClick={refresh}>
            Try again
          </button>
        </p>
      </div>
    );
  const { data } = load;
  const { orders, stock, reviews, sales, topProducts } = data;
  const can = (permission: string) => session?.permissions.includes(permission) ?? false;
  const attention: Array<{
    href: string;
    tone: "warn" | "err" | "info";
    icon: IconName;
    n: number;
    text: string;
  }> = [];
  if (orders?.open.pending)
    attention.push({
      href: ordersHref({ status: "pending" }),
      tone: "warn",
      icon: "clock",
      n: orders.open.pending,
      text: `pending ${orders.open.pending === 1 ? "order" : "orders"} to confirm`,
    });
  if (orders?.delayed)
    attention.push({
      href: ordersHref({ delayed: true }),
      tone: "err",
      icon: "alert",
      n: orders.delayed,
      text: "delayed",
    });
  if (stock && stock.low + stock.out)
    attention.push({
      href: "/workspace/inventory?state=low",
      tone: "warn",
      icon: "layers",
      n: stock.low + stock.out,
      text: "low or out of stock",
    });
  if (reviews?.pending)
    attention.push({
      href: "/workspace/reviews",
      tone: "info",
      icon: "star",
      n: reviews.pending,
      text: `${reviews.pending === 1 ? "review" : "reviews"} to moderate`,
    });
  const watched = Boolean(orders || stock || reviews);
  const today = sales?.today ?? null;
  const yesterday = sales?.yesterday ?? null;

  return (
    <div className="dash">
      {watched &&
        (attention.length ? (
          <nav className="attn" aria-label="Needs attention">
            {attention.map((item) => (
              <Link className="attn-i" href={item.href} key={item.text}>
                <span className={`ic ic-${item.tone}`}>
                  <Icon name={item.icon} />
                </span>
                <b>{item.n}</b> {item.text}
              </Link>
            ))}
          </nav>
        ) : (
          <div className="note ok">
            <Icon name="check-c" />
            <p>
              <b>All caught up.</b> Nothing is waiting in the areas you look after.
            </p>
          </div>
        ))}

      {orders && (
        <div className="kpis">
          {sales ? (
            <>
              <Kpi
                label="Revenue today"
                value={today ? money(today.totalFils) : "—"}
                foot={
                  today ? (
                    <Delta now={today.totalFils} before={yesterday?.totalFils ?? null} />
                  ) : (
                    <span className="delta-c">Not computed yet</span>
                  )
                }
                href="/workspace/analytics"
              />
              <Kpi
                label="Orders today"
                value={orders.placedToday.toLocaleString("en-AE")}
                foot={
                  <Delta
                    now={orders.placedToday}
                    before={orders.placedYesterdaySoFar}
                    label="vs this time yesterday"
                  />
                }
                href="/workspace/orders"
                live
              />
              <Kpi
                label="Avg. order value"
                value={today?.aovFils != null ? money(today.aovFils) : "—"}
                foot={
                  today?.aovFils != null ? (
                    <Delta now={today.aovFils} before={yesterday?.aovFils ?? null} />
                  ) : (
                    <span className="delta-c">
                      {today ? "No orders yet today" : "Not computed yet"}
                    </span>
                  )
                }
                href="/workspace/analytics"
              />
            </>
          ) : (
            <>
              <Kpi
                label="Today’s orders"
                value={orders.placedToday.toLocaleString("en-AE")}
                foot={
                  <Delta
                    now={orders.placedToday}
                    before={orders.placedYesterdaySoFar}
                    label="vs this time yesterday"
                  />
                }
                href="/workspace/orders"
                live
              />
              <Kpi
                label="Processing"
                value={(orders.open.confirmed + orders.open.processing).toLocaleString("en-AE")}
                foot={<span className="delta-c">Confirmed or packing</span>}
                href={ordersHref({ status: "processing" })}
                live
              />
              <Kpi
                label="Out for delivery"
                value={orders.open.outForDelivery.toLocaleString("en-AE")}
                foot={<span className="delta-c">With the courier</span>}
                href={ordersHref({ status: "out_for_delivery" })}
                live
              />
            </>
          )}
          <Kpi
            label="Pending orders"
            value={orders.open.pending.toLocaleString("en-AE")}
            foot={
              orders.delayed ? (
                <span className="delta-c">
                  <b className="err-t">{orders.delayed} waiting too long</b>
                </span>
              ) : (
                <span className="delta-c">Need confirmation</span>
              )
            }
            href={ordersHref({ status: "pending" })}
            live
          />
        </div>
      )}

      <div className="qa">
        {can("orders.create") && (
          <Link className="btn btn-s" href={newOrderHref}>
            <Icon name="plus" />
            Create order
          </Link>
        )}
        {can("catalog.write") && (
          <Link className="btn btn-s" href={newProductHref}>
            <Icon name="box" />
            Add product
          </Link>
        )}
        {orders && (
          <Link className="btn btn-s" href={ordersHref({ status: "pending" })}>
            <Icon name="clock" />
            Pending orders
          </Link>
        )}
        {stock && (
          <Link className="btn btn-s" href="/workspace/inventory?state=low">
            <Icon name="layers" />
            Check low stock
          </Link>
        )}
      </div>

      <div className="split wide">
        {orders && (
          <section className="card" aria-labelledby="recent-title">
            <div className="card-h">
              <h2 id="recent-title">Recent orders</h2>
              <Link className="btn btn-g btn-sm" href="/workspace/orders">
                View all
                <Icon name="arr-r" size="sm" />
              </Link>
            </div>
            <RecentOrders lines={orders.recent} now={data.generatedAt} />
          </section>
        )}
        <div className="stack">
          {orders && (
            <section className="card" aria-labelledby="attention-title">
              <div className="card-h">
                <h2 id="attention-title">Needs attention</h2>
                {orders.attention.length > 0 && <span className="sub">Oldest first</span>}
              </div>
              {orders.attention.length ? (
                <div className="list">
                  {orders.attention.map((line) => (
                    <Link className="li" href={orderHref(line.id)} key={line.id}>
                      <span className={`ic ${line.delayed ? "ic-err" : "ic-warn"} li-ic`}>
                        <Icon name={line.delayed ? "alert" : "clock"} size="sm" />
                      </span>
                      <span className="li-b">
                        <b>
                          {line.orderNumber}
                          {line.customerName ? ` · ${line.customerName}` : ""}
                        </b>
                        <small>
                          {ORDER_STATUS_LABELS[line.status] ?? line.status} for{" "}
                          {ago(line.createdAt, data.generatedAt)}
                          {line.delayed ? " · delayed" : ""}
                        </small>
                      </span>
                      <Icon name="cr" size="sm" />
                    </Link>
                  ))}
                </div>
              ) : (
                <Empty
                  icon="check-c"
                  title="Nothing waiting"
                  text="New orders that need a decision appear here."
                />
              )}
              <p className="card-note">
                Delayed: pending over {orders.delayedAfterMinutes.pending / 60} h, confirmed or
                processing over {orders.delayedAfterMinutes.inProgress / 60} h.
              </p>
            </section>
          )}
          {stock && (
            <section className="card" aria-labelledby="stock-title">
              <div className="card-h">
                <h2 id="stock-title">Low stock</h2>
                <Link className="btn btn-g btn-sm" href="/workspace/inventory?state=low">
                  Inventory
                  <Icon name="arr-r" size="sm" />
                </Link>
              </div>
              {stock.items.length ? (
                <div className="list">
                  {stock.items.map((item) => (
                    <div className="li" key={item.variantId}>
                      <span className="li-b">
                        <b>{item.productName}</b>
                        <small>
                          {item.stock <= 0 ? (
                            <>
                              <span className="err-t">Out of stock</span> · still visible on store
                            </>
                          ) : (
                            <>
                              <span className="warn-t">{item.stock} left</span> · alert level{" "}
                              {item.threshold}
                            </>
                          )}{" "}
                          · <span className="mono">{item.sku}</span>
                        </small>
                      </span>
                      <Link className="btn btn-s btn-sm" href={variantStockHref(item.variantId)}>
                        Update
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  icon="check-c"
                  title="Stock looks healthy"
                  text="No product on sale is at or below its alert level."
                />
              )}
            </section>
          )}
        </div>
      </div>

      <div className="grid g2">
        {orders && <Pipeline open={orders.open} />}
        {topProducts && (
          <section className="card" aria-labelledby="top-title">
            <div className="card-h">
              <h2 id="top-title">Best-selling products</h2>
              <span className="sub">
                By units · {topProducts.from} to {topProducts.to}
              </span>
            </div>
            <div className="card-b">
              {topProducts.items.length ? (
                <div className="rank">
                  {topProducts.items.map((item, index) => {
                    const top = Math.max(1, ...topProducts.items.map((row) => row.units));
                    return (
                      <Link
                        className="rank-i"
                        href={productHref(item.productId)}
                        key={item.productId}
                      >
                        <span className="n">{index + 1}</span>
                        <span className="t">{item.name}</span>
                        <span className="v">
                          {item.units} {item.units === 1 ? "unit" : "units"}
                          {item.netFils !== null && (
                            <span className="muted small"> · {money(item.netFils)}</span>
                          )}
                        </span>
                        <span className="b">
                          <i style={{ width: `${(item.units / top) * 100}%` }} />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  icon="chart"
                  title="No sales in the last seven days"
                  text="Orders not cancelled are counted here."
                />
              )}
            </div>
          </section>
        )}
        {sales ? (
          <section className="card" aria-labelledby="sales-title">
            <div className="card-h">
              <h2 id="sales-title">Booked sales</h2>
              <span className="sub">Today and yesterday</span>
            </div>
            <div className="card-b sales-days">
              <SalesDay label="Today" day={sales.today} />
              <SalesDay label="Yesterday" day={sales.yesterday} />
              <p className="card-note">
                Orders placed and not cancelled, by order date (Asia/Dubai), in {sales.currency}.{" "}
                {sales.taxNote}
              </p>
            </div>
          </section>
        ) : (
          orders && (
            <section className="card" aria-labelledby="access-title">
              <div className="card-h">
                <h2 id="access-title">Your access</h2>
              </div>
              <div className="card-b prose">
                <p>
                  You are signed in as <b>Staff</b>. You can manage orders, products, categories,
                  brands and inventory, and look up customers for order support.
                </p>
                <p>
                  Revenue, analytics, reports, storefront content and settings are managed by the
                  Owner.
                </p>
              </div>
            </section>
          )
        )}
      </div>

      <p className="muted small dash-time">
        Updated {dubaiTime(data.generatedAt)} Dubai time ·{" "}
        <button className="link-btn" type="button" onClick={refresh}>
          Refresh
        </button>
      </p>
    </div>
  );
}

/** The prototype's KPI tile (`kpis`): label, value and a line under it; the whole tile links. */
function Kpi(props: {
  label: string;
  value: string;
  foot: ReactNode;
  href: string;
  live?: boolean;
}) {
  return (
    <Link className="kpi" href={props.href}>
      <span className="kpi-l">
        {props.label}
        {props.live && <span className="tag muted live-tag">Live</span>}
      </span>
      <span className="kpi-v">{props.value}</span>
      <span className="kpi-f">
        <span>{props.foot}</span>
      </span>
    </Link>
  );
}

/** The prototype's change against an earlier figure (`deltaHtml`); nothing to compare, no arrow. */
function Delta({
  now,
  before,
  label = "vs yesterday",
}: {
  now: number;
  before: number | null;
  label?: string;
}) {
  // Nothing to compare with: say why instead of drawing a change.
  if (before === null) return <span className="delta-c">No figure for yesterday yet</span>;
  if (before === 0) return <span className="delta-c">None {label.replace("vs ", "")}</span>;
  const change = ((now - before) / before) * 100;
  const flat = Math.abs(change) < 0.5;
  const up = change > 0;
  return (
    <>
      <span className={`delta ${flat ? "flat" : up ? "up" : "down"}`}>
        {!flat && <Icon name={up ? "up" : "down"} />}
        {flat ? "No change" : `${up ? "+" : ""}${change.toFixed(1)}%`}
      </span>
      <span className="delta-c">{label}</span>
    </>
  );
}

/** The prototype's order-status bar (`sbar`/`sleg`), here for the open orders right now. */
function Pipeline({ open }: { open: NonNullable<AdminDashboard["orders"]>["open"] }) {
  const parts = [
    { key: "pending", label: "Pending", count: open.pending, css: "pending" },
    { key: "confirmed", label: "Confirmed", count: open.confirmed, css: "confirmed" },
    { key: "processing", label: "Processing", count: open.processing, css: "processing" },
    { key: "out_for_delivery", label: "Out for delivery", count: open.outForDelivery, css: "ofd" },
  ];
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  return (
    <section className="card" aria-labelledby="pipe-title">
      <div className="card-h">
        <h2 id="pipe-title">
          Open orders <span className="sub">· right now</span>
        </h2>
        <Link className="btn btn-g btn-sm" href="/workspace/orders">
          All orders
          <Icon name="arr-r" size="sm" />
        </Link>
      </div>
      <div className="card-b">
        <div className="sbar" role="img" aria-label={`${total} open orders by status`}>
          {parts.map((part) =>
            part.count ? (
              <i
                key={part.key}
                style={{
                  width: `${(part.count / total) * 100}%`,
                  background: `var(--st-${part.css})`,
                }}
              />
            ) : null,
          )}
        </div>
        <div className="sleg">
          {parts.map((part) => (
            <Link key={part.key} href={ordersHref({ status: part.key })}>
              <span className="dotc" style={{ background: `var(--st-${part.css})` }} />
              <span>{part.label}</span>
              <b>{part.count}</b>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function SalesDay({ label, day }: { label: string; day: SalesDayData }) {
  return (
    <div className="sales-day">
      <span className="kpi-l">{label}</span>
      <span className="kpi-v">{day ? money(day.totalFils) : "—"}</span>
      <span className="delta-c">
        {day ? (
          <>
            {day.orders} {day.orders === 1 ? "order" : "orders"}
            {day.aovFils !== null ? ` · average ${money(day.aovFils)}` : ""}
            {day.cancelledOrders ? ` · ${day.cancelledOrders} cancelled` : ""} · as of{" "}
            {dubaiTime(day.computedAt)}
          </>
        ) : (
          "Not computed yet"
        )}
      </span>
    </div>
  );
}

function Empty({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty dash-empty">
      <div className="ic">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** Recent orders: the prototype's table from 720 px, its order rows (`orderRowM`) on a phone. */
function RecentOrders({ lines, now }: { lines: OrderLine[]; now: string }) {
  if (!lines.length)
    return (
      <Empty icon="orders" title="No orders yet" text="New orders appear here as they come in." />
    );
  const status = (value: string) => (
    <span className={`st st-${value === "out_for_delivery" ? "ofd" : value}`}>
      {ORDER_STATUS_LABELS[value] ?? value}
    </span>
  );
  return (
    <>
      <div className="only-d dash-tbl">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Placed</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <Link className="lnk-id" href={orderHref(line.id)}>
                      {line.orderNumber}
                    </Link>
                  </td>
                  <td>{line.customerName ?? "—"}</td>
                  <td className="num">{money(line.totalFils)}</td>
                  <td>
                    {status(line.status)}
                    {line.delayed && <span className="err-t small"> · delayed</span>}
                  </td>
                  <td className="muted small">{ago(line.createdAt, now)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="only-m dash-rows">
        {lines.slice(0, 5).map((line) => (
          <Link className="mrow" href={orderHref(line.id)} key={line.id}>
            <span className="mrow-b">
              <span className="mrow-t">
                <span className="lnk-id">{line.orderNumber}</span>
                {status(line.status)}
              </span>
              <span className="mrow-t">
                <b>{line.customerName ?? "—"}</b>
                <span className="amt">{money(line.totalFils)}</span>
              </span>
              <span className="meta">
                <span>{ago(line.createdAt, now)} ago</span>
                {line.delayed && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="err-t">delayed</span>
                  </>
                )}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
