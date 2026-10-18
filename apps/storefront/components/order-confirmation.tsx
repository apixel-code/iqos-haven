"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  addressLines,
  confirmationView,
  optionText,
  placedText,
  rememberedPlaced,
  STATUS_TEXT,
  subtotalFils,
  type ConfirmationView,
} from "@/lib/checkout/confirmation";
import { SITE } from "@/lib/site";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { WhatsAppLink } from "./whatsapp-link";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

/** One row of the prototype's "What happens next" (`steps`). */
function Step({ done, title, children }: { done?: boolean; title: string; children: ReactNode }) {
  return (
    <li>
      <span className={done ? "dot on" : "dot"} aria-hidden="true">
        {done && <Icon name="check" size="sm" />}
      </span>
      <span>
        <b>
          {title}
          {done && <span className="sr"> (done)</span>}
        </b>
        <span>{children}</span>
      </span>
    </li>
  );
}

/**
 * Order confirmation (roadmap step 81, ADR 0050). The order is read from the API with the
 * HttpOnly confirmation cookie; there is no order number, phone or token in the URL and
 * nothing is kept on the device. What is shown is the API's snapshot: no customer name or
 * phone, and every amount as the API gave it. When the cookie no longer opens the order, the
 * page says so and the order itself is unaffected.
 */
export function OrderConfirmation({ whatsappNumber }: { whatsappNumber: string | null }) {
  const [view, setView] = useState<ConfirmationView | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/store/order-confirmation", {
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
      .then(async (response) =>
        setView(confirmationView(response.status, await response.json().catch(() => null))),
      )
      .catch(() => {
        if (!controller.signal.aborted) setView({ kind: "failed", limited: false });
      });
    return () => controller.abort();
  }, [attempt]);

  if (!view)
    return (
      <div className="done">
        <p role="status" className="small muted">
          Loading your order…
        </p>
      </div>
    );
  const actions = (orderNumber: string | null) => (
    <div className="co-actions">
      <Link href="/shop" prefetch={false} className="btn btn-primary">
        Continue shopping
      </Link>
      <WhatsAppLink
        number={whatsappNumber}
        className="btn btn-wa"
        message={
          orderNumber
            ? WHATSAPP_MESSAGES.order(SITE.name, orderNumber)
            : WHATSAPP_MESSAGES.general(SITE.name)
        }
      >
        <Icon name="wa" size="sm" />
        {orderNumber ? "Message us about this order" : "Message us"}
      </WhatsAppLink>
    </div>
  );
  if (view.kind === "failed")
    return (
      <div role="alert" className="done">
        <h1 className="h1">We couldn&apos;t load your order</h1>
        <p className="muted">
          {view.limited
            ? "Too many tries. Wait a minute and try again."
            : "Something went wrong on our side. If you placed an order, it is not affected."}
        </p>
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setView(null);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  if (view.kind === "expired") {
    // Known only if the order was placed in this visit; a reload forgets it.
    const known = rememberedPlaced();
    return (
      <div className="done">
        <h1 className="h1">{known ? "Your order was placed" : "This order can't be shown here"}</h1>
        {known ? (
          <p className="muted">
            Order <b className="mono ink">{known.orderNumber}</b> · <Money fils={known.totalFils} />{" "}
            cash on delivery. We can&apos;t show its details on this device right now, but the order
            is not affected.
          </p>
        ) : (
          <p className="muted">
            Order details can be opened for 30 minutes after ordering, in the browser that placed
            the order. If you placed an order, it is not affected.
          </p>
        )}
        {actions(known?.orderNumber ?? null)}
      </div>
    );
  }

  const { order } = view;
  const address = addressLines(order.address);
  return (
    <div className="done">
      <span className="done-ic" aria-hidden="true">
        <Icon name="check" size="xl" />
      </span>
      <div className="done-head">
        <h1 className="h1">Order placed. Thank you.</h1>
        <p className="lead">
          Order <span className="mono ink">{order.orderNumber}</span> · {placedText(order.placedAt)}
        </p>
        <p className="done-status">{STATUS_TEXT[order.status]}</p>
      </div>
      <div className="cashbox">
        <span>Pay in cash on delivery</span>
        <b>
          <Money fils={order.totalFils} />
        </b>
      </div>
      {order.status !== "cancelled" && (
        <section className="panel" aria-labelledby="next-h">
          <h2 className="h3" id="next-h">
            What happens next
          </h2>
          <ol className="steps">
            <Step done title="Order received">
              {placedText(order.placedAt)}
            </Step>
            <Step done={order.status !== "pending"} title="We confirm your order">
              We will contact you on the mobile number you gave.
            </Step>
            <Step done={order.status === "delivered"} title="Delivery">
              {order.etaText}
              <span className="block">To {address.join(", ")}</span>
            </Step>
            <Step done={order.status === "delivered"} title="Pay and receive">
              Have the cash ready for the courier.
            </Step>
          </ol>
        </section>
      )}
      <section className="panel" aria-labelledby="items-h">
        <h2 className="h3" id="items-h">
          Items
        </h2>
        <ul className="mini-lines">
          {order.items.map((item, index) => (
            <li key={index} className="mini-line no-th">
              <span>
                <span className="nm">{item.name}</span>
                {optionText(item.attributes) && (
                  <>
                    <br />
                    <span className="v">{optionText(item.attributes)}</span>
                  </>
                )}
              </span>
              <span className="num muted">
                {item.quantity} × <Money fils={item.unitPriceFils} />
              </span>
            </li>
          ))}
        </ul>
        <dl className="totals">
          <div>
            <dt>Subtotal</dt>
            <dd>
              <Money fils={subtotalFils(order)} />
            </dd>
          </div>
          {order.discountFils > 0 && (
            <div className="disc">
              <dt>Discount</dt>
              <dd>
                −<Money fils={order.discountFils} />
              </dd>
            </div>
          )}
          <div>
            <dt>Delivery</dt>
            <dd>
              <Money fils={order.deliveryFeeFils} />
            </dd>
          </div>
          <div className="grand">
            <dt>Total to pay</dt>
            <dd>
              <Money fils={order.totalFils} />
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel" aria-labelledby="addr-h">
        <h2 className="h3" id="addr-h">
          Delivery address
        </h2>
        <address className="muted done-addr">
          {address.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </address>
      </section>
      {actions(order.orderNumber)}
    </div>
  );
}
