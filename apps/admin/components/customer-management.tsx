"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { adminCustomerResponseSchema, adminCustomersResponseSchema } from "@ih/contracts";
import { isUuid, newOrderForPhone, orderHref } from "../lib/links";
import { COD_STATUS_LABELS, money, when } from "../lib/orders";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { StatusBadge } from "./order-management";
import { PageHead } from "./page-head";
import { useUrlQuery } from "./use-url-query";

/** The prototype's initials avatar (`initials`). */
function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

/**
 * Customers (roadmap step 90, ADR 0058) in the prototype's layout (`VIEWS.customers`,
 * `VIEWS.customer`, ADR 0097 V-A7). No accounts: a customer is a phone number and the orders
 * placed with it. Contact, addresses and order history are operational; spend appears only when
 * the API includes it (Owner, `customers.financial_read`). Read-only.
 */
export function CustomerManagement({ permissions }: { permissions: readonly string[] }) {
  // Search as you type, after a pause, like the prototype.
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = typed.trim().slice(0, 100);
      if (next !== search) {
        setSearch(next);
        setCursors([]);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [typed, search]);
  // The open customer lives in the URL (`?customer=`, parity G-A2).
  const { get, navigate } = useUrlQuery();
  const urlCustomer = get("customer");
  const selected = isUuid(urlCustomer) ? urlCustomer : null;
  const setSelected = (id: string | null) => navigate({ customer: id }, true);
  const params = new URLSearchParams({ limit: "25" });
  if (search) params.set("q", search);
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const customers = useManagementResource(`/customers?${params}`, adminCustomersResponseSchema);
  if (selected)
    return (
      <CustomerDetail
        id={selected}
        canCreateOrder={permissions.includes("orders.create")}
        onBack={() => setSelected(null)}
      />
    );
  const items = customers.data?.items ?? [];
  const showSpend = items.some((item) => item.spend);
  const pager = customers.data && (
    <div className="tbl-f">
      <span>
        {items.length} {items.length === 1 ? "customer" : "customers"} on this page
      </span>
      <div className="pager">
        <button
          type="button"
          aria-label="Previous page"
          disabled={cursors.length === 0 || customers.busy}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          <Icon name="cl" size="sm" />
        </button>
        <button type="button" aria-current="page" aria-label={`Page ${cursors.length + 1}`}>
          {cursors.length + 1}
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!customers.data.nextCursor || customers.busy}
          onClick={() => setCursors((value) => [...value, customers.data!.nextCursor!])}
        >
          <Icon name="cr" size="sm" />
        </button>
      </div>
    </div>
  );
  return (
    <>
      <PageHead title="Customers" sub="Everyone who has ordered, grouped by phone number." />
      <div className="note">
        <Icon name="info" />
        <p>
          Customers don&apos;t create accounts on the store. Each customer is grouped by{" "}
          <b>phone number</b> from their orders, so repeat orders with the same number appear
          together.
        </p>
      </div>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <label className="sr" htmlFor="customers-q">
            Search customers
          </label>
          <input
            id="customers-q"
            name="q"
            type="search"
            inputMode="search"
            maxLength={100}
            placeholder="Search name or phone number"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Enter searches at once.
              setSearch(typed.trim().slice(0, 100));
              setCursors([]);
            }}
          />
        </div>
      </div>
      <ResourceNotice resource={customers} compact />
      {customers.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name="users" />
              </div>
              <h3>No customers found</h3>
              <p>
                {search
                  ? `No customer matches “${search}”. Phone search needs at least 3 digits.`
                  : "Customers appear here after their first order."}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="tbl-wrap only-d">
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th className="num">Orders</th>
                      {showSpend && <th className="num">Booked spend</th>}
                      <th>Last order</th>
                      <th>Area</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="click" onClick={() => setSelected(item.id)}>
                        <td>
                          <div className="cellp">
                            <span className="av" aria-hidden="true">
                              {initials(item.name)}
                            </span>
                            <button
                              type="button"
                              className="cust-link"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelected(item.id);
                              }}
                            >
                              {item.name}
                            </button>
                            {item.noShow && <span className="tag out">No-show</span>}
                          </div>
                        </td>
                        <td className="mono small">{item.phone}</td>
                        <td className="num">
                          {item.orderCount}
                          {item.orderCount > 1 && <span className="tag info repeat">Repeat</span>}
                        </td>
                        {showSpend && (
                          <td className="num">{item.spend ? money(item.spend.bookedFils) : "—"}</td>
                        )}
                        <td className="small">{item.lastOrderAt ? when(item.lastOrderAt) : "—"}</td>
                        <td className="small muted">{item.areaName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pager}
            </div>
            {/* Phones: the prototype's customer rows in place of the table. */}
            <div className="only-m">
              <div className="mlist">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="mrow"
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="av" aria-hidden="true">
                      {initials(item.name)}
                    </span>
                    <span className="mrow-b">
                      <span className="mrow-t">
                        <b>{item.name}</b>
                        {item.spend && <span className="amt">{money(item.spend.bookedFils)}</span>}
                      </span>
                      <span className="meta">
                        <span className="mono">{item.phone}</span>
                      </span>
                      <span className="meta">
                        <span>
                          {item.orderCount} {item.orderCount === 1 ? "order" : "orders"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Last {item.lastOrderAt ? when(item.lastOrderAt) : "—"}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="tbl-wrap orders-mpager">{pager}</div>
            </div>
          </>
        ))}
    </>
  );
}

function CustomerDetail({
  id,
  canCreateOrder,
  onBack,
}: {
  id: string;
  canCreateOrder: boolean;
  onBack: () => void;
}) {
  const customer = useManagementResource(`/customers/${id}`, adminCustomerResponseSchema);
  const data = customer.data;
  const kept = data ? data.orderCount - data.cancelledCount : 0;
  return (
    <div className="stack customer-detail">
      <button type="button" className="backlink" onClick={onBack}>
        <Icon name="arr-l" size="sm" />
        Customers
      </button>
      <ResourceNotice resource={customer} compact />
      {data && (
        <>
          <PageHead
            title={
              <span className="cust-title">
                <span className="av lg" aria-hidden="true">
                  {initials(data.name)}
                </span>
                {data.name}
                {data.noShow && <span className="tag out">No-show</span>}
              </span>
            }
            sub={
              <>
                <span className="mono">{data.phone}</span>
                {data.firstOrderAt ? ` · customer since ${when(data.firstOrderAt)}` : ""}
              </>
            }
            actions={
              <>
                {/* Opens WhatsApp with the number; nothing is sent or recorded here. */}
                <a
                  className="btn btn-wa"
                  href={`https://wa.me/${data.phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="wa" />
                  WhatsApp
                </a>
                <a className="btn btn-s" href={`tel:${data.phone}`}>
                  <Icon name="phone" />
                  Call
                </a>
                {canCreateOrder && (
                  <Link className="btn btn-s" href={newOrderForPhone(data.phone)}>
                    <Icon name="plus" />
                    New order
                  </Link>
                )}
              </>
            }
          />
          <div className="kpis">
            <div className="kpi">
              <span className="kpi-l">Orders</span>
              <span className="kpi-v">{data.orderCount}</span>
              <span className="kpi-f">
                <span className="delta-c">{data.cancelledCount} cancelled</span>
              </span>
            </div>
            {data.spend && (
              <>
                <div className="kpi">
                  <span className="kpi-l">Booked spend</span>
                  <span className="kpi-v">{money(data.spend.bookedFils)}</span>
                  <span className="kpi-f">
                    <span className="delta-c">
                      Orders not cancelled · {money(data.spend.deliveredFils)} delivered
                    </span>
                  </span>
                </div>
                <div className="kpi">
                  <span className="kpi-l">Avg. order</span>
                  <span className="kpi-v">
                    {kept > 0 ? money(Math.round(data.spend.bookedFils / kept)) : "—"}
                  </span>
                  <span className="kpi-f">
                    <span className="delta-c">Booked spend per order kept</span>
                  </span>
                </div>
              </>
            )}
            <div className="kpi">
              <span className="kpi-l">Last order</span>
              <span className="kpi-v kpi-v-sm">
                {data.lastOrderAt ? when(data.lastOrderAt) : "—"}
              </span>
              <span className="kpi-f">
                <span className="delta-c">
                  {data.orderCount > 1 ? "Repeat customer" : "First-time customer"}
                </span>
              </span>
            </div>
          </div>
          <div className="split">
            <section className="card cust-orders" aria-labelledby="cust-orders-h">
              <div className="card-h">
                <h2 id="cust-orders-h">Order history</h2>
                <span className="sub">All orders placed with {data.phone}</span>
              </div>
              {data.orders.length === 0 ? (
                <div className="card-b">
                  <p className="small muted">
                    {data.orderCount > 0
                      ? "Order history needs the orders permission."
                      : "No orders yet."}
                  </p>
                </div>
              ) : (
                <>
                  <div className="only-d cust-tbl">
                    <div className="tbl-scroll">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Order</th>
                            <th>Date</th>
                            <th className="num">Total</th>
                            <th>Payment</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.orders.map((order) => (
                            <tr key={order.id}>
                              <td>
                                <Link className="lnk-id" href={orderHref(order.id)}>
                                  {order.orderNumber}
                                </Link>
                              </td>
                              <td className="small">{when(order.createdAt)}</td>
                              <td className="num">{money(order.totalFils)}</td>
                              <td className="small">{COD_STATUS_LABELS[order.codStatus]}</td>
                              <td>
                                <StatusBadge status={order.status} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="only-m">
                    <div className="mlist cust-mlist">
                      {data.orders.map((order) => (
                        <Link key={order.id} className="mrow" href={orderHref(order.id)}>
                          <span className="mrow-b">
                            <span className="mrow-t">
                              <span className="lnk-id">{order.orderNumber}</span>
                              <StatusBadge status={order.status} />
                            </span>
                            <span className="mrow-t">
                              <span className="small">{when(order.createdAt)}</span>
                              <span className="amt">{money(order.totalFils)}</span>
                            </span>
                            <span className="meta">
                              <span>{COD_STATUS_LABELS[order.codStatus]}</span>
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                  {data.orderCount > data.orders.length && (
                    <p className="help cust-more">
                      Showing the latest {data.orders.length} of {data.orderCount} orders.
                    </p>
                  )}
                </>
              )}
            </section>
            <div className="stack">
              <section className="card" aria-labelledby="cust-addr-h">
                <div className="card-h">
                  <h2 id="cust-addr-h">Known delivery details</h2>
                </div>
                {data.addresses.length === 0 ? (
                  <div className="card-b">
                    <p className="small muted">No saved address.</p>
                  </div>
                ) : (
                  <div className="list cust-addr">
                    {data.addresses.map((address) => (
                      <div className="li" key={address.id}>
                        <Icon name="pin" />
                        <span className="li-b">
                          <span className="small">
                            {[address.unit, address.building, address.street]
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                          <small>
                            {address.areaName}, {address.emirate}
                            {address.makani ? ` · Makani ${address.makani}` : ""}
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              {data.spend && (
                <p className="help">Collected cash is recorded per order, not shown here.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
