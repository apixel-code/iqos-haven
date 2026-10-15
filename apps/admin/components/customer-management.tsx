"use client";
import { useState } from "react";
import { adminCustomerResponseSchema, adminCustomersResponseSchema } from "@ih/contracts";
import { COD_STATUS_LABELS, money, ORDER_STATUS_LABELS, when } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

/**
 * Customers (roadmap step 90, ADR 0058). No accounts: a customer is a phone number and the
 * orders placed with it. Contact, addresses and order history are operational; spend appears
 * only when the API includes it (Owner, `customers.financial_read`). Read-only.
 */
export function CustomerManagement() {
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "25" });
  if (search) params.set("q", search);
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const customers = useManagementResource(`/customers?${params}`, adminCustomersResponseSchema);
  if (selected) return <CustomerDetail id={selected} onBack={() => setSelected(null)} />;
  const showSpend = customers.data?.items.some((item) => item.spend) ?? false;
  return (
    <section className="management-card order-management">
      <header className="card-heading">
        <div>
          <h2>Customers</h2>
          <p className="muted">
            Customers don&apos;t create accounts. Orders with the same phone number are grouped
            together.
          </p>
        </div>
      </header>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(String(new FormData(event.currentTarget).get("q") ?? "").trim());
          setCursors([]);
        }}
      >
        <label>
          <span>Search customers</span>
          <input name="q" placeholder="Search name or phone number" maxLength={100} />
        </label>
        <div className="form-actions">
          <button type="submit" className="secondary-button">
            Search
          </button>
        </div>
      </form>
      <ResourceNotice resource={customers} />
      {customers.data &&
        (customers.data.items.length === 0 ? (
          <p className="muted">
            {search
              ? `No customer matches “${search}”. Phone search needs at least 3 digits.`
              : "Customers appear here after their first order."}
          </p>
        ) : (
          <div className="order-table-wrap">
            <table className="order-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Orders</th>
                  {showSpend && <th>Booked spend</th>}
                  <th>Last order</th>
                  <th>Area</th>
                </tr>
              </thead>
              <tbody>
                {customers.data.items.map((item) => (
                  <tr
                    key={item.id}
                    tabIndex={0}
                    onClick={() => setSelected(item.id)}
                    onKeyDown={(event) => event.key === "Enter" && setSelected(item.id)}
                  >
                    <td>
                      <button
                        type="button"
                        className="order-link"
                        onClick={() => setSelected(item.id)}
                      >
                        {item.name}
                      </button>
                    </td>
                    <td className="mono">{item.phone}</td>
                    <td>
                      {item.orderCount}
                      {item.orderCount > 1 && <small>Repeat</small>}
                    </td>
                    {showSpend && <td>{item.spend ? money(item.spend.bookedFils) : "—"}</td>}
                    <td>{item.lastOrderAt ? when(item.lastOrderAt) : "—"}</td>
                    <td className="muted">{item.areaName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {customers.data && (
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={cursors.length === 0 || customers.busy}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous page
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!customers.data.nextCursor || customers.busy}
            onClick={() => setCursors((value) => [...value, customers.data!.nextCursor!])}
          >
            Next page
          </button>
        </div>
      )}
    </section>
  );
}

function CustomerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const customer = useManagementResource(`/customers/${id}`, adminCustomerResponseSchema);
  const data = customer.data;
  return (
    <section className="management-card order-detail">
      <div>
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back to customers
        </button>
      </div>
      <ResourceNotice resource={customer} />
      {data && (
        <>
          <header className="card-heading">
            <div>
              <h2>{data.name}</h2>
              <p className="muted">
                <span className="mono">{data.phone}</span>
                {data.firstOrderAt ? ` · customer since ${when(data.firstOrderAt)}` : ""}
              </p>
            </div>
            <a className="secondary-button" href={`tel:${data.phone}`}>
              Call
            </a>
          </header>
          <div className="order-detail-grid">
            <article className="record-card">
              <h3>Orders</h3>
              <p>
                <strong>{data.orderCount}</strong> · {data.cancelledCount} cancelled
              </p>
              {data.lastOrderAt && <p className="muted">Last order {when(data.lastOrderAt)}</p>}
            </article>
            {data.spend && (
              <article className="record-card">
                <h3>Spend (Owner)</h3>
                <dl className="order-totals">
                  <div>
                    <dt>Booked (not cancelled)</dt>
                    <dd>{money(data.spend.bookedFils)}</dd>
                  </div>
                  <div>
                    <dt>Delivered</dt>
                    <dd>{money(data.spend.deliveredFils)}</dd>
                  </div>
                </dl>
                <p className="muted">Collected cash is recorded per order, not shown here.</p>
              </article>
            )}
          </div>
          <article className="record-card">
            <h3>Known delivery details</h3>
            {data.addresses.length === 0 ? (
              <p className="muted">No saved address.</p>
            ) : (
              <ul className="record-list">
                {data.addresses.map((address) => (
                  <li key={address.id}>
                    {[address.unit, address.building, address.street].filter(Boolean).join(", ")} ·{" "}
                    {address.areaName}
                    {address.makani && <small> · Makani {address.makani}</small>}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="record-card">
            <h3>Order history</h3>
            {data.orders.length === 0 ? (
              <p className="muted">
                {data.orderCount > 0
                  ? "Order history needs the orders permission."
                  : "No orders yet."}
              </p>
            ) : (
              <table className="order-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Placed</th>
                    <th>Amount</th>
                    <th>Payment</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((order) => (
                    <tr key={order.id}>
                      <td className="mono">{order.orderNumber}</td>
                      <td>{when(order.createdAt)}</td>
                      <td>{money(order.totalFils)}</td>
                      <td>{COD_STATUS_LABELS[order.codStatus]}</td>
                      <td>
                        <span className={`order-status status-${order.status}`}>
                          {ORDER_STATUS_LABELS[order.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </>
      )}
    </section>
  );
}
