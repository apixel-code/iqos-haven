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
import { displayAed } from "@/lib/store/listing";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { WhatsAppLink } from "./whatsapp-link";

const PANEL = "flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 sm:p-6";
const PRIMARY =
  "inline-flex h-11 items-center rounded-pill bg-primary px-5 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function Step({ done, title, children }: { done?: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs ${done ? "border-success bg-success text-white" : "border-line-2"}`}
      >
        {done ? "✓" : ""}
      </span>
      <span className="flex flex-col">
        <b className="text-[14.5px] font-semibold">{title}</b>
        <span className="text-[13.5px] text-ink-3">{children}</span>
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
      <p role="status" className="py-9 text-sm text-ink-2">
        Loading your order…
      </p>
    );
  const actions = (orderNumber: string | null) => (
    <div className="flex flex-wrap gap-2.5">
      <Link href="/shop" prefetch={false} className={PRIMARY}>
        Continue shopping
      </Link>
      <WhatsAppLink
        number={whatsappNumber}
        message={
          orderNumber
            ? WHATSAPP_MESSAGES.order(SITE.name, orderNumber)
            : WHATSAPP_MESSAGES.general(SITE.name)
        }
      >
        {orderNumber ? "Message us about this order" : "Message us"}
      </WhatsAppLink>
    </div>
  );
  if (view.kind === "failed")
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-6">
        <h1 className="text-2xl font-semibold">We couldn&apos;t load your order</h1>
        <p className="text-sm text-ink-2">
          {view.limited
            ? "Too many tries. Wait a minute and try again."
            : "Something went wrong on our side. If you placed an order, it is not affected."}
        </p>
        <button
          type="button"
          className={PRIMARY}
          onClick={() => {
            setView(null);
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  if (view.kind === "expired") {
    // Known only if the order was placed in this visit; a reload forgets it.
    const known = rememberedPlaced();
    return (
      <div className="mx-auto flex max-w-[680px] flex-col gap-4 py-6">
        <h1 className="text-2xl font-semibold">
          {known ? "Your order was placed" : "This order can't be shown here"}
        </h1>
        {known ? (
          <p className="text-sm text-ink-2">
            Order <b className="font-mono font-semibold text-ink">{known.orderNumber}</b> ·{" "}
            {displayAed(known.totalFils)} cash on delivery. We can&apos;t show its details on this
            device right now, but the order is not affected.
          </p>
        ) : (
          <p className="text-sm text-ink-2">
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
    <div className="mx-auto flex max-w-[680px] flex-col gap-6 py-6">
      <div className="flex flex-col gap-2">
        <span
          aria-hidden
          className="flex size-[72px] items-center justify-center rounded-full bg-success text-3xl text-white"
        >
          ✓
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Order placed. Thank you.</h1>
        <p className="text-sm text-ink-2">
          Order <b className="font-mono font-semibold text-ink">{order.orderNumber}</b> ·{" "}
          {placedText(order.placedAt)}
        </p>
        <p className="text-sm font-medium">{STATUS_TEXT[order.status]}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink px-5 py-[18px] text-surface">
        <span className="text-sm">Pay in cash on delivery</span>
        <b className="text-2xl font-semibold">{displayAed(order.totalFils)}</b>
      </div>
      {order.status !== "cancelled" && (
        <section className={PANEL}>
          <h2 className="text-lg font-semibold">What happens next</h2>
          <ol className="flex flex-col gap-4">
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
      <section className={PANEL}>
        <h2 className="text-lg font-semibold">Items</h2>
        <ul className="flex flex-col gap-3 text-sm">
          {order.items.map((item, index) => (
            <li key={index} className="flex justify-between gap-4">
              <span>
                <span className="font-medium">{item.name}</span>
                <span className="block text-xs text-ink-3">{optionText(item.attributes)}</span>
              </span>
              <span className="whitespace-nowrap text-ink-2">
                {item.quantity} × {displayAed(item.unitPriceFils)}
              </span>
            </li>
          ))}
        </ul>
        <dl className="flex flex-col gap-2 border-t border-line pt-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt>Subtotal</dt>
            <dd>{displayAed(subtotalFils(order))}</dd>
          </div>
          {order.discountFils > 0 && (
            <div className="flex justify-between gap-4 text-success">
              <dt>Discount</dt>
              <dd>−{displayAed(order.discountFils)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt>Delivery</dt>
            <dd>{displayAed(order.deliveryFeeFils)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-line pt-2 text-lg font-semibold">
            <dt>Total to pay</dt>
            <dd>{displayAed(order.totalFils)}</dd>
          </div>
        </dl>
      </section>
      <section className={PANEL}>
        <h2 className="text-lg font-semibold">Delivery address</h2>
        <address className="text-sm not-italic text-ink-2">
          {address.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
      </section>
      {actions(order.orderNumber)}
    </div>
  );
}
