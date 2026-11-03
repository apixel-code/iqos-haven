"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import {
  areaText,
  TRACK_HEADLINE,
  trackingView,
  trackSteps,
  type TrackingView,
} from "@/lib/checkout/tracking";
import { optionText, placedText } from "@/lib/checkout/confirmation";
import { SITE } from "@/lib/site";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";
import { WhatsAppLink } from "./whatsapp-link";

/**
 * Track an order (ADR 0104, Marina 2026-11-03): the order number alone, from the confirmation
 * email or page. The number is posted to the API and kept only in this page's memory; the
 * answer shows the status, the items and the cash to pay, never who ordered or the address.
 */
export function OrderTracking({ whatsappNumber }: { whatsappNumber: string | null }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<TrackingView | null>(null);
  const result = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!typed.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/store/order-tracking", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderNumber: typed.trim() }),
      });
      setView(trackingView(response.status, await response.json().catch(() => null)));
    } catch {
      setView({ kind: "failed" });
    } finally {
      setBusy(false);
      requestAnimationFrame(() => result.current?.focus());
    }
  }

  return (
    <div className="track">
      <div className="track-head">
        <h1 className="h1">Track your order</h1>
        <p className="muted">
          Enter the order number from your confirmation email or page, for example IH-482193057316.
        </p>
      </div>
      <form className="track-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label htmlFor="track-number" className="label">
            Order number
          </label>
          <input
            id="track-number"
            className="input mono"
            name="orderNumber"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            placeholder="IH-…"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !typed.trim()}>
          {busy ? "Looking…" : "Track order"}
        </button>
      </form>

      <div ref={result} tabIndex={-1} aria-live="polite" className="track-result">
        {view?.kind === "missing" && (
          <p role="alert" className="track-note">
            We couldn&apos;t find an order with that number. Check it against your confirmation
            email. Orders placed before 3 November 2026 can&apos;t be tracked here; message us
            instead.
          </p>
        )}
        {view?.kind === "limited" && (
          <p role="alert" className="track-note">
            Too many tries. Wait a few minutes and try again, or message us on WhatsApp.
          </p>
        )}
        {view?.kind === "failed" && (
          <p role="alert" className="track-note">
            Something went wrong on our side. Try again in a moment.
          </p>
        )}
        {view?.kind === "shown" && <TrackedOrder view={view} />}
      </div>

      <div className="co-actions">
        <Link href="/shop" prefetch={false} className="btn">
          Continue shopping
        </Link>
        <WhatsAppLink
          number={whatsappNumber}
          className="btn btn-wa"
          message={
            view?.kind === "shown"
              ? WHATSAPP_MESSAGES.order(SITE.name, view.order.orderNumber)
              : WHATSAPP_MESSAGES.general(SITE.name)
          }
        >
          <Icon name="wa" size="sm" />
          Message us
        </WhatsAppLink>
      </div>
    </div>
  );
}

function TrackedOrder({ view: { order } }: { view: Extract<TrackingView, { kind: "shown" }> }) {
  const cancelled = order.status === "cancelled";
  return (
    <>
      <section className="panel" aria-labelledby="track-status-h">
        <p className="eyebrow">
          Order <span className="mono ink">{order.orderNumber}</span> · {placedText(order.placedAt)}
        </p>
        <h2 className="h3" id="track-status-h">
          {TRACK_HEADLINE[order.status]}
        </h2>
        {!cancelled && (
          <ol className="steps track-steps">
            {trackSteps(order).map((step) => (
              <li key={step.status} aria-current={step.current ? "step" : undefined}>
                <span className={step.done ? "dot on" : "dot"} aria-hidden="true">
                  {step.done && <Icon name="check" size="sm" />}
                </span>
                <span>
                  <b>
                    {step.title}
                    {step.done && <span className="sr"> (done)</span>}
                  </b>
                  <span>
                    {step.at
                      ? placedText(step.at)
                      : step.status === "out_for_delivery" || step.status === "delivered"
                        ? order.etaText
                        : step.done
                          ? "Done"
                          : "Next"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="small muted">Delivery to {areaText(order.area)}</p>
      </section>
      <section className="panel" aria-labelledby="track-items-h">
        <h2 className="h3" id="track-items-h">
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
              <Money fils={order.merchandiseSubtotalFils} />
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
            <dt>{cancelled ? "Total" : "Total to pay in cash"}</dt>
            <dd>
              <Money fils={order.totalFils} />
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
