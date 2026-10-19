"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useState } from "react";
import {
  adminCustomerResponseSchema,
  adminCustomersResponseSchema,
  EMIRATE_NAMES,
  manualOrderRequestSchema,
  manualOrderResponseSchema,
  MANUAL_CONFIRMATION_CHANNELS,
  normalizePhone,
  storeDeliveryResponseSchema,
  storeQuoteResponseSchema,
  type AdminCustomerResponse,
  type OrderItemChoice,
  type StoreQuoteResponse,
} from "@ih/contracts";
import { ApiError } from "../lib/auth";
import { managementError, managementRequest, validate } from "../lib/management";
import { money } from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { choiceLabel, OrderItemPicker } from "./order-item-picker";

const CHANNEL_LABELS: Record<(typeof MANUAL_CONFIRMATION_CHANNELS)[number], string> = {
  phone: "Phone call",
  whatsapp: "WhatsApp",
  in_person: "In person",
};
interface Line {
  choice: OrderItemChoice;
  quantity: string;
}
type SavedAddress = AdminCustomerResponse["addresses"][number];
/** The returning customer found by phone, or `null` when the number has no orders yet. */
type Lookup = { phone: string; customer: AdminCustomerResponse | null };
const newKey = () => crypto.randomUUID();

/**
 * Manual order (roadmap step 88, ADR 0056): a staff member enters an order for a customer who
 * ordered by phone, WhatsApp or in person. The total comes from the same server quote as the
 * storefront and must be fetched again after any change; the attempt key is kept until the
 * order is acknowledged, so pressing Create again after an unclear answer is safe.
 *
 * Items come from the product picker (parity G-A1, ADR 0080). With `customers.read`, a phone
 * number finds a returning customer: their name and a saved address can be used as a start.
 */
export function ManualOrderPanel({
  canConfirm,
  canLookUp,
  onCreated,
  onCancel,
}: {
  canConfirm: boolean;
  canLookUp: boolean;
  onCreated: (orderId: string) => void;
  onCancel: () => void;
}) {
  const choices = useManagementResource("/orders/delivery-areas", storeDeliveryResponseSchema);
  const [lines, setLines] = useState<Line[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupMessage, setLookupMessage] = useState("");
  // A saved address fills the address fields; the key remounts them with its values.
  const [start, setStart] = useState<{ key: number; address: SavedAddress | null }>({
    key: 0,
    address: null,
  });
  const [areaId, setAreaId] = useState("");
  const [coupon, setCoupon] = useState("");
  const [quote, setQuote] = useState<StoreQuoteResponse | null>(null);
  const [attempt, setAttempt] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const priced = () => ({
    lines: lines.map((line) => ({
      variantId: line.choice.variantId,
      quantity: Number(line.quantity),
    })),
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

  async function findCustomer() {
    let e164: string;
    try {
      e164 = normalizePhone(phone);
    } catch {
      setLookup(null);
      setLookupMessage("Enter a UAE mobile number, e.g. 50 123 4567.");
      return;
    }
    setBusy(true);
    setLookupMessage("");
    try {
      // The list matches part of a number; only the exact one is this customer.
      const matches = await managementRequest(
        `/customers?${new URLSearchParams({ q: e164.slice(4), limit: "10" })}`,
        adminCustomersResponseSchema,
      );
      const match = matches.items.find((item) => item.phone === e164);
      const customer = match
        ? await managementRequest(`/customers/${match.id}`, adminCustomerResponseSchema)
        : null;
      setLookup({ phone: e164, customer });
      if (customer) setName(customer.name);
    } catch (error) {
      setLookup(null);
      setLookupMessage(managementError(error));
    } finally {
      setBusy(false);
    }
  }

  function applyAddress(address: SavedAddress) {
    if (!choices.data?.areas.some((area) => area.id === address.areaId)) {
      setLookupMessage(`${address.areaName} is not served now. Choose another area below.`);
      return;
    }
    setLookupMessage("");
    changed(setAreaId)(address.areaId);
    setStart((current) => ({ key: current.key + 1, address }));
  }

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
        contact: { name, phone },
        address: {
          areaId,
          type: String(data.get("type") ?? "apartment"),
          building: String(data.get("building") ?? ""),
          unit: String(data.get("unit") ?? "") || null,
          street: String(data.get("street") ?? "") || null,
          makani: String(data.get("makani") ?? "") || null,
          notes: String(data.get("notes") ?? "") || null,
        },
        // The area travels inside the address; the order request has no top-level area.
        lines: priced().lines,
        couponCode: priced().couponCode,
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
    if (
      !(await confirmDialog({
        title: `Create this order for ${money(quote.totalFils)}?`,
        ok: "Create order",
      }))
    )
      return;
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
        <button data-leave type="button" className="secondary-button" onClick={onCancel}>
          Back to orders
        </button>
      </header>
      <ResourceNotice resource={choices} />
      {choices.data && (
        <form
          data-unsaved="this new order"
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void create(new FormData(event.currentTarget));
          }}
        >
          <h3 className="wide-field">Customer</h3>
          <label>
            <span>UAE mobile</span>
            <input
              name="phone"
              required
              inputMode="tel"
              placeholder="50 123 4567"
              autoComplete="off"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setLookup(null);
                setLookupMessage("");
              }}
            />
          </label>
          <label>
            <span>Full name</span>
            <input
              name="name"
              required
              maxLength={100}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {canLookUp && (
            <div className="form-actions wide-field">
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !phone.trim()}
                onClick={() => void findCustomer()}
              >
                Find customer by phone
              </button>
            </div>
          )}
          {lookupMessage && (
            <p role="alert" className="wide-field">
              {lookupMessage}
            </p>
          )}
          {lookup && !lookup.customer && (
            <p className="wide-field muted" role="status">
              New customer: no orders under {lookup.phone}. Enter their name and address.
            </p>
          )}
          {lookup?.customer && (
            <div className="customer-found wide-field" role="status">
              <p>
                <strong>Returning customer: {lookup.customer.name}</strong>{" "}
                <span className="muted">
                  {lookup.customer.orderCount} previous order(s)
                  {lookup.customer.lastOrderAt &&
                    ` · last ${new Date(lookup.customer.lastOrderAt).toLocaleDateString("en-GB")}`}
                </span>
              </p>
              {lookup.customer.noShow && (
                <p role="alert">Marked as a no-show before: confirm the order with them first.</p>
              )}
              {lookup.customer.addresses.length > 0 ? (
                <ul aria-label="Saved addresses">
                  {lookup.customer.addresses.slice(0, 3).map((address) => (
                    <li key={address.id}>
                      <span>
                        {[address.building, address.unit, address.street]
                          .filter(Boolean)
                          .join(", ")}
                        <small className="muted"> · {address.areaName}</small>
                      </span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => applyAddress(address)}
                      >
                        Use this address
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No saved address.</p>
              )}
            </div>
          )}
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
          <AddressFields key={start.key} address={start.address} />
          <h3 className="wide-field">Items</h3>
          {lines.length > 0 && (
            <div className="order-lines wide-field" aria-label="In this order">
              {lines.map((line) => (
                <div key={line.choice.variantId} className="order-line">
                  <label>
                    <span>
                      {line.choice.brandName} {line.choice.productName} · {choiceLabel(line.choice)}{" "}
                      · {money(line.choice.unitPriceFils)}
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={line.quantity}
                      aria-label={`Quantity of ${line.choice.productName}`}
                      onChange={(event) =>
                        changed(setLines)(
                          lines.map((entry) =>
                            entry === line ? { ...entry, quantity: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <span />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => changed(setLines)(lines.filter((entry) => entry !== line))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <OrderItemPicker
            taken={new Set(lines.map((line) => line.choice.variantId))}
            onPick={(choice) => changed(setLines)([...lines, { choice, quantity: "1" }])}
          />
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
              disabled={busy || !areaId || lines.length === 0}
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

/** The address fields, empty or started from a returning customer's saved address. */
function AddressFields({ address }: { address: SavedAddress | null }) {
  return (
    <>
      <label>
        <span>Address type</span>
        <select name="type" defaultValue={address?.type ?? "apartment"}>
          <option value="apartment">Apartment</option>
          <option value="villa">Villa</option>
          <option value="office">Office / Hotel</option>
        </select>
      </label>
      <label>
        <span>Building or villa</span>
        <input name="building" required maxLength={150} defaultValue={address?.building ?? ""} />
      </label>
      <label>
        <span>Unit (not for a villa)</span>
        <input name="unit" maxLength={50} defaultValue={address?.unit ?? ""} />
      </label>
      <label>
        <span>Street or landmark (optional)</span>
        <input name="street" maxLength={150} defaultValue={address?.street ?? ""} />
      </label>
      <label>
        <span>Makani (optional)</span>
        <input
          name="makani"
          inputMode="numeric"
          maxLength={14}
          defaultValue={address?.makani ?? ""}
        />
      </label>
      <label className="wide-field">
        <span>Delivery notes (optional)</span>
        <textarea name="notes" maxLength={500} rows={2} defaultValue={address?.notes ?? ""} />
      </label>
    </>
  );
}
