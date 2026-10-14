"use client";
import { useState } from "react";
import {
  EMIRATE_NAMES,
  manualOrderRequestSchema,
  manualOrderResponseSchema,
  MANUAL_CONFIRMATION_CHANNELS,
  storeDeliveryResponseSchema,
  storeQuoteResponseSchema,
  type StoreQuoteResponse,
} from "@ih/contracts";
import { ApiError } from "../lib/auth";
import { managementError, managementRequest, validate } from "../lib/management";
import { money } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

const CHANNEL_LABELS: Record<(typeof MANUAL_CONFIRMATION_CHANNELS)[number], string> = {
  phone: "Phone call",
  whatsapp: "WhatsApp",
  in_person: "In person",
};
interface Line {
  variantId: string;
  quantity: string;
}
const newKey = () => crypto.randomUUID();

/**
 * Manual order (roadmap step 88, ADR 0056): a staff member enters an order for a customer who
 * ordered by phone, WhatsApp or in person. The total comes from the same server quote as the
 * storefront and must be fetched again after any change; the attempt key is kept until the
 * order is acknowledged, so pressing Create again after an unclear answer is safe.
 */
export function ManualOrderPanel({
  canConfirm,
  onCreated,
  onCancel,
}: {
  canConfirm: boolean;
  onCreated: (orderId: string) => void;
  onCancel: () => void;
}) {
  const choices = useManagementResource("/orders/delivery-areas", storeDeliveryResponseSchema);
  const [lines, setLines] = useState<Line[]>([{ variantId: "", quantity: "1" }]);
  const [areaId, setAreaId] = useState("");
  const [coupon, setCoupon] = useState("");
  const [quote, setQuote] = useState<StoreQuoteResponse | null>(null);
  const [attempt, setAttempt] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const priced = () => ({
    lines: lines
      .filter((line) => line.variantId.trim())
      .map((line) => ({ variantId: line.variantId.trim(), quantity: Number(line.quantity) })),
    areaId,
    couponCode: coupon.trim() || null,
  });
  // Anything that changes the price makes the shown total stale.
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setQuote(null);
    };

  async function getTotal() {
    setBusy(true);
    setMessage("");
    try {
      setQuote(
        await managementRequest("/orders/quote", storeQuoteResponseSchema, "POST", priced()),
      );
    } catch (error) {
      setQuote(null);
      setMessage(managementError(error, true));
    } finally {
      setBusy(false);
    }
  }

  async function create(data: FormData) {
    if (!quote) return;
    const start = data.get("start") === "confirmed" ? "confirmed" : "pending";
    let request;
    try {
      request = validate(manualOrderRequestSchema, {
        contact: { name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? "") },
        address: {
          areaId,
          type: String(data.get("type") ?? "apartment"),
          building: String(data.get("building") ?? ""),
          unit: String(data.get("unit") ?? "") || null,
          street: String(data.get("street") ?? "") || null,
          makani: String(data.get("makani") ?? "") || null,
          notes: String(data.get("notes") ?? "") || null,
        },
        ...priced(),
        quoteToken: quote.quote.token,
        ageConfirmed: data.get("age") === "on",
        start,
        ...(start === "confirmed"
          ? {
              evidence: {
                channel: String(data.get("channel") ?? ""),
                note: String(data.get("evidenceNote") ?? ""),
              },
            }
          : {}),
      });
    } catch {
      setMessage(
        "Check the customer name and UAE mobile, the address, the 18+ confirmation and, for a confirmed order, how it was confirmed.",
      );
      return;
    }
    if (!window.confirm(`Create this order for ${money(quote.totalFils)}?`)) return;
    setBusy(true);
    setMessage("");
    try {
      const placed = await managementRequest(
        "/orders",
        manualOrderResponseSchema,
        "POST",
        request,
        undefined,
        { "Idempotency-Key": attempt },
      );
      setAttempt(newKey());
      onCreated(placed.orderId);
    } catch (error) {
      // A definite refusal placed nothing, so the next try is a new attempt. An unclear answer
      // (no answer, 5xx, too many, still in progress) or "this key already made an order"
      // keeps the key: pressing Create again is then the same order, never a second one.
      const definite =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429 &&
        !["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_CONFLICT", "CHECKOUT_RECOVERY_REQUIRED"].includes(
          error.code ?? "",
        );
      if (definite) setAttempt(newKey());
      setMessage(managementError(error, true));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-card order-detail">
      <header className="card-heading">
        <div>
          <h2>New order</h2>
          <p className="muted">For a customer who ordered by phone, WhatsApp or in person.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Back to orders
        </button>
      </header>
      <ResourceNotice resource={choices} />
      {choices.data && (
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void create(new FormData(event.currentTarget));
          }}
        >
          <h3 className="wide-field">Customer</h3>
          <label>
            <span>Full name</span>
            <input name="name" required maxLength={100} autoComplete="off" />
          </label>
          <label>
            <span>UAE mobile</span>
            <input
              name="phone"
              required
              inputMode="tel"
              placeholder="50 123 4567"
              autoComplete="off"
            />
          </label>
          <h3 className="wide-field">Delivery</h3>
          <label>
            <span>Area</span>
            <select
              value={areaId}
              required
              onChange={(event) => changed(setAreaId)(event.target.value)}
            >
              <option value="">Select the area</option>
              {choices.data.areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name} · {EMIRATE_NAMES[area.emirate]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Address type</span>
            <select name="type" defaultValue="apartment">
              <option value="apartment">Apartment</option>
              <option value="villa">Villa</option>
              <option value="office">Office / Hotel</option>
            </select>
          </label>
          <label>
            <span>Building or villa</span>
            <input name="building" required maxLength={150} />
          </label>
          <label>
            <span>Unit (not for a villa)</span>
            <input name="unit" maxLength={50} />
          </label>
          <label>
            <span>Street or landmark (optional)</span>
            <input name="street" maxLength={150} />
          </label>
          <label>
            <span>Makani (optional)</span>
            <input name="makani" inputMode="numeric" maxLength={14} />
          </label>
          <label className="wide-field">
            <span>Delivery notes (optional)</span>
            <textarea name="notes" maxLength={500} rows={2} />
          </label>
          <h3 className="wide-field">Items</h3>
          {lines.map((line, index) => (
            <div key={index} className="wide-field form-grid">
              <label>
                <span>Variant ID</span>
                <input
                  value={line.variantId}
                  placeholder="UUID"
                  onChange={(event) =>
                    changed(setLines)(
                      lines.map((entry, i) =>
                        i === index ? { ...entry, variantId: event.target.value } : entry,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>Quantity</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={line.quantity}
                  onChange={(event) =>
                    changed(setLines)(
                      lines.map((entry, i) =>
                        i === index ? { ...entry, quantity: event.target.value } : entry,
                      ),
                    )
                  }
                />
              </label>
            </div>
          ))}
          <div className="form-actions wide-field">
            <button
              type="button"
              className="secondary-button"
              onClick={() => changed(setLines)([...lines, { variantId: "", quantity: "1" }])}
            >
              Add item
            </button>
          </div>
          <label>
            <span>Coupon code (optional)</span>
            <input
              value={coupon}
              maxLength={32}
              onChange={(event) => changed(setCoupon)(event.target.value)}
            />
          </label>
          <div className="form-actions wide-field">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !areaId}
              onClick={() => void getTotal()}
            >
              Get total
            </button>
          </div>
          {quote && (
            <dl className="order-totals wide-field">
              <div>
                <dt>Merchandise</dt>
                <dd>{money(quote.merchandiseSubtotalFils)}</dd>
              </div>
              <div>
                <dt>Discount</dt>
                <dd>−{money(quote.discountFils)}</dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{money(quote.deliveryFeeFils)}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>
                  <strong>{money(quote.totalFils)}</strong>
                </dd>
              </div>
              {quote.insufficientStock.length > 0 && (
                <p role="alert">Not enough stock for {quote.insufficientStock.length} item(s).</p>
              )}
            </dl>
          )}
          <h3 className="wide-field">Start</h3>
          <label>
            <span>Status</span>
            <select name="start" defaultValue="pending">
              <option value="pending">Pending (confirm later)</option>
              {canConfirm && <option value="confirmed">Confirmed now</option>}
            </select>
          </label>
          {canConfirm && (
            <>
              <label>
                <span>Confirmed by (for a confirmed start)</span>
                <select name="channel" defaultValue="phone">
                  {MANUAL_CONFIRMATION_CHANNELS.map((channel) => (
                    <option key={channel} value={channel}>
                      {CHANNEL_LABELS[channel]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide-field">
                <span>How it was confirmed (for a confirmed start)</span>
                <input name="evidenceNote" maxLength={300} />
              </label>
            </>
          )}
          <label className="wide-field">
            <span>
              <input type="checkbox" name="age" /> The customer confirmed they are 18 or older.
            </span>
          </label>
          {message && (
            <p role="alert" className="wide-field">
              {message}
            </p>
          )}
          <div className="form-actions wide-field">
            <button type="submit" className="primary-button" disabled={busy || !quote}>
              {quote ? `Create order · ${money(quote.totalFils)}` : "Get the total first"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
