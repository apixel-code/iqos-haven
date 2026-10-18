"use client";

import { useRef } from "react";
import { EMIRATE_NAMES, type AdminOrderResponse } from "@ih/contracts";
import { money, ORDER_STATUS_LABELS, when } from "../lib/orders";

const ADDRESS_TYPES = { apartment: "Apartment", villa: "Villa", office: "Office / Hotel" } as const;
const options = (attributes: Record<string, string>) => Object.values(attributes).join(" · ");

/**
 * Packing slip for the courier (parity G-A6, ADR 0090): a preview in a dialog and a printed
 * page. Only the slip prints (print rules in globals.css). It carries what the courier and the
 * packer need: where to deliver, what to pack and how much cash to collect. The internal
 * operational note is not printed; the customer's delivery note is.
 */
export function PackingSlip({
  order,
  storeName = "Iqos Haven",
}: {
  order: AdminOrderResponse & { customer: NonNullable<AdminOrderResponse["customer"]> };
  /** The store's final name (BI-01). */
  storeName?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { customer } = order;
  const address = customer.address;
  const emirate =
    EMIRATE_NAMES[order.area.emirate as keyof typeof EMIRATE_NAMES] ?? order.area.emirate;
  const collect =
    order.status === "cancelled"
      ? "Cancelled: nothing to collect"
      : order.codStatus === "collected"
        ? "Already collected"
        : money(order.totalFils);
  return (
    <>
      <button
        type="button"
        className="secondary-button"
        onClick={() => dialog.current?.showModal()}
      >
        Packing slip
      </button>
      <dialog ref={dialog} className="slip-dialog" aria-labelledby={`slip-${order.id}`}>
        <header className="card-heading slip-chrome">
          <div>
            <h2 id={`slip-${order.id}`}>Order summary</h2>
            <p className="muted">Packing slip layout for the courier</p>
          </div>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={() => window.print()}>
              Print
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
          </div>
        </header>
        <article className="packing-slip">
          <div className="slip-head">
            <strong className="slip-store">{storeName}</strong>
            <span className="slip-number">{order.orderNumber}</span>
          </div>
          <div className="slip-columns">
            <section>
              <h3>Deliver to</h3>
              <p>
                <strong>{customer.name}</strong>
              </p>
              <p>{[address.building, address.unit, address.street].filter(Boolean).join(", ")}</p>
              <p>
                {ADDRESS_TYPES[address.type]}
                {address.makani ? ` · Makani ${address.makani}` : ""}
              </p>
              <p>
                {order.area.name}, {emirate}
              </p>
              <p className="slip-mono">{customer.phone}</p>
              {address.notes && <p className="slip-note">Delivery note: {address.notes}</p>}
            </section>
            <section>
              <h3>Order</h3>
              <p>{when(order.createdAt)}</p>
              <p>{ORDER_STATUS_LABELS[order.status]}</p>
              <p>Cash on Delivery</p>
            </section>
          </div>
          <table className="slip-items">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>
                      {item.brandName} {item.productName}
                    </strong>
                    {options(item.attributes) && <> · {options(item.attributes)}</>}
                    <small className="slip-mono">{item.sku}</small>
                  </td>
                  <td>{item.quantity}</td>
                  <td>{money(item.totalFils)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="slip-totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{money(order.merchandiseSubtotalFils)}</dd>
            </div>
            {order.discountFils > 0 && (
              <div>
                <dt>Discount{order.coupon ? ` (${order.coupon.code})` : ""}</dt>
                <dd>−{money(order.discountFils)}</dd>
              </div>
            )}
            <div>
              <dt>Delivery</dt>
              <dd>{order.deliveryFeeFils === 0 ? "Free" : money(order.deliveryFeeFils)}</dd>
            </div>
            <div className="slip-collect">
              <dt>Collect in cash</dt>
              <dd>{collect}</dd>
            </div>
          </dl>
        </article>
      </dialog>
    </>
  );
}
