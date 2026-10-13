"use client";
import { useState } from "react";
import {
  adminOrderResponseSchema,
  adminOrdersResponseSchema,
  type AdminOrderResponse,
  type AdminOrderSummary,
} from "@ih/contracts";
import { addressLine, COD_STATUS_LABELS, money, ORDER_STATUS_LABELS, when } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

const STATUSES = [
  "all",
  "pending",
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;

/** Read-only order operations for step 83. Commands are added by the following roadmap steps. */
export function OrderManagement({ canReadContact }: { canReadContact: boolean }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "25" });
  if (status !== "all") params.set("status", status);
  if (search) params.set("q", search);
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const orders = useManagementResource(`/orders?${params}`, adminOrdersResponseSchema);
  const resetPage = () => setCursors([]);
  if (selected) return <OrderDetail id={selected} onBack={() => setSelected(null)} />;
  return (
    <section className="management-card order-management">
      <header className="card-heading">
        <div>
          <h2>Orders</h2>
          <p className="muted">Newest first · immutable order snapshots</p>
        </div>
        <span className="badge">Read only · actions arrive in steps 84–89</span>
      </header>
      <div className="tab-list" role="tablist" aria-label="Order status">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="secondary-button"
            aria-selected={status === value}
            onClick={() => {
              setStatus(value);
              resetPage();
            }}
          >
            {value === "all" ? "All" : ORDER_STATUS_LABELS[value]}
          </button>
        ))}
      </div>
      <form
        key={`${search}|${from}|${to}`}
        className="order-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setSearch(String(data.get("q") ?? "").trim());
          setFrom(String(data.get("from") ?? ""));
          setTo(String(data.get("to") ?? ""));
          resetPage();
        }}
      >
        <label className="wide-field">
          <span>Search {canReadContact ? "order number, customer or phone" : "order number"}</span>
          <input name="q" type="search" maxLength={100} defaultValue={search} />
        </label>
        <label>
          <span>Placed from</span>
          <input name="from" type="datetime-local" defaultValue={from} />
        </label>
        <label>
          <span>Placed before</span>
          <input name="to" type="datetime-local" defaultValue={to} />
        </label>
        <div className="form-actions wide-field">
          <button type="submit" className="primary-button">
            Apply filters
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSearch("");
              setFrom("");
              setTo("");
              setStatus("all");
              resetPage();
            }}
          >
            Clear filters
          </button>
        </div>
      </form>
      <ResourceNotice resource={orders} />
      {orders.data && (
        <>
          {orders.data.items.length === 0 ? (
            <p className="muted">No orders match these filters.</p>
          ) : (
            <div className="order-table-wrap">
              <table className="order-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Amount</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((order) => (
                    <OrderRow key={order.id} order={order} open={() => setSelected(order.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={cursors.length === 0 || orders.busy}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous page
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!orders.data.nextCursor || orders.busy}
              onClick={() => setCursors((value) => [...value, orders.data!.nextCursor!])}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function OrderRow({ order, open }: { order: AdminOrderSummary; open: () => void }) {
  return (
    <tr tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      <td>
        <button type="button" className="order-link" onClick={open}>
          {order.orderNumber}
        </button>
        <small>{order.source}</small>
      </td>
      <td>
        {order.customer ? (
          <>
            <strong>{order.customer.name}</strong>
            <small>{order.customer.phone}</small>
          </>
        ) : (
          <span className="muted">Contact hidden</span>
        )}
      </td>
      <td>{order.itemCount}</td>
      <td>{money(order.totalFils)}</td>
      <td>{COD_STATUS_LABELS[order.codStatus]}</td>
      <td>
        <span className={`order-status status-${order.status}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </td>
      <td>
        {when(order.createdAt)}
        <small>{order.areaName}</small>
      </td>
    </tr>
  );
}

function OrderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const order = useManagementResource(`/orders/${id}`, adminOrderResponseSchema);
  return (
    <section className="management-card order-detail">
      <div>
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back to orders
        </button>
      </div>
      <ResourceNotice resource={order} />
      {order.data && <OrderDetailBody order={order.data} />}
    </section>
  );
}

function OrderDetailBody({ order }: { order: AdminOrderResponse }) {
  return (
    <>
      <header className="card-heading">
        <div>
          <h2>{order.orderNumber}</h2>
          <p className="muted">
            Placed {when(order.createdAt)} · {order.source} · version {order.version}
          </p>
        </div>
        <span className={`order-status status-${order.status}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </header>
      <div className="order-detail-grid">
        <article className="record-card">
          <h3>Customer & delivery</h3>
          {order.customer ? (
            <>
              <strong>{order.customer.name}</strong>
              <a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>
              <p>{addressLine(order)}</p>
              {order.customer.address.makani && <p>Makani: {order.customer.address.makani}</p>}
              {order.customer.address.notes && (
                <p className="muted">{order.customer.address.notes}</p>
              )}
            </>
          ) : (
            <p className="muted">Customer contact requires Customers permission.</p>
          )}
          <p className="muted">{order.deliveryEtaText}</p>
        </article>
        <article className="record-card">
          <h3>Payment</h3>
          <p>{COD_STATUS_LABELS[order.codStatus]}</p>
          <dl className="order-totals">
            <div>
              <dt>Merchandise</dt>
              <dd>{money(order.merchandiseSubtotalFils)}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>−{money(order.discountFils)}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>{money(order.deliveryFeeFils)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                <strong>{money(order.totalFils)}</strong>
              </dd>
            </div>
          </dl>
          {order.coupon && (
            <p className="muted">
              Coupon {order.coupon.code} · {order.coupon.percentBps / 100}%
            </p>
          )}
        </article>
      </div>
      <article className="record-card">
        <h3>Items</h3>
        <div className="record-list">
          {order.items.map((item) => (
            <div className="order-item" key={item.id}>
              <div>
                <strong>{item.productName}</strong>
                <small>
                  {item.brandName} · {item.categoryName} · {item.sku}
                </small>
                <small>{Object.values(item.attributes).join(" · ") || "Standard"}</small>
              </div>
              <div>
                {item.quantity} × {money(item.unitPriceFils)}
                <strong>{money(item.totalFils)}</strong>
              </div>
            </div>
          ))}
        </div>
      </article>
      <article className="record-card">
        <h3>History</h3>
        <ol className="order-history">
          {order.history.map((entry) => (
            <li key={entry.id}>
              <span className={`order-status status-${entry.toStatus}`}>
                {ORDER_STATUS_LABELS[entry.toStatus]}
              </span>
              <div>
                <strong>
                  {entry.actorName ??
                    (entry.actorKind === "customer" ? "Customer checkout" : "System")}
                </strong>
                <small>
                  {when(entry.createdAt)} · version {entry.orderVersion}
                </small>
                {entry.reason && <p>{entry.reason}</p>}
              </div>
            </li>
          ))}
        </ol>
      </article>
    </>
  );
}
