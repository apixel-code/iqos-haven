"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useEffect, useRef, useState } from "react";
import { toast } from "../lib/ui/toast";
import { Icon } from "./icons";
import { PageHead } from "./page-head";
import { useUnsavedChanges } from "./unsaved-guard";
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
type Address = {
  type: "apartment" | "villa" | "office";
  building: string;
  unit: string;
  street: string;
  makani: string;
  notes: string;
};
const EMPTY_ADDRESS: Address = {
  type: "apartment",
  building: "",
  unit: "",
  street: "",
  makani: "",
  notes: "",
};
/** The prototype's steps (`NO_STEPS`). */
const STEPS = ["Customer", "Products", "Delivery", "Review"] as const;

export function ManualOrderPanel({
  canConfirm,
  canLookUp,
  initialPhone,
  onCreated,
  onCancel,
}: {
  canConfirm: boolean;
  canLookUp: boolean;
  /** From a customer's "New order" (V-A7): the phone is filled in and looked up at once. */
  initialPhone?: string;
  onCreated: (orderId: string) => void;
  onCancel: () => void;
}) {
  const choices = useManagementResource("/orders/delivery-areas", storeDeliveryResponseSchema);
  const [step, setStep] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupMessage, setLookupMessage] = useState("");
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [areaId, setAreaId] = useState("");
  const [coupon, setCoupon] = useState("");
  const [quote, setQuote] = useState<StoreQuoteResponse | null>(null);
  const [startAs, setStartAs] = useState<"pending" | "confirmed">("pending");
  const [channel, setChannel] = useState<(typeof MANUAL_CONFIRMATION_CHANNELS)[number]>("phone");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [age, setAge] = useState(false);
  const [attempt, setAttempt] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [stepError, setStepError] = useState("");
  // Anything typed or picked is unsaved until the order is created (parity G-A9).
  useUnsavedChanges(
    phone || name || lines.length || address.building || areaId ? "this new order" : null,
  );
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
  const setField = (field: keyof Address, value: string) =>
    setAddress((current) => ({ ...current, [field]: value }));

  // A customer's "New order" starts with that customer found, as in the prototype.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !initialPhone || !canLookUp) return;
    const frame = requestAnimationFrame(() => {
      prefilled.current = true;
      void findCustomer();
    });
    return () => cancelAnimationFrame(frame);
  });
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

  function applyAddress(saved: SavedAddress) {
    if (!choices.data?.areas.some((area) => area.id === saved.areaId)) {
      setLookupMessage(`${saved.areaName} is not served now. Choose another area on Delivery.`);
      return;
    }
    setLookupMessage("");
    changed(setAreaId)(saved.areaId);
    setAddress({
      type: saved.type as Address["type"],
      building: saved.building,
      unit: saved.unit ?? "",
      street: saved.street ?? "",
      makani: saved.makani ?? "",
      notes: saved.notes ?? "",
    });
    toast("Saved address filled in on the Delivery step");
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

  /** What stops the shopper's details on this step, or "" when it can go on. */
  function problem(at: number): string {
    if (at === 0) {
      try {
        normalizePhone(phone);
      } catch {
        return "Enter the customer's UAE mobile number, e.g. 50 123 4567.";
      }
      if (!name.trim()) return "Enter the customer's name.";
    }
    if (at === 1) {
      if (lines.length === 0) return "Add at least one product.";
      if (lines.some((line) => !/^([1-9]|10)$/.test(line.quantity)))
        return "Each quantity is a whole number from 1 to 10.";
    }
    if (at === 2) {
      if (!areaId) return "Choose the delivery area.";
      if (!address.building.trim()) return "Enter the building or villa.";
    }
    return "";
  }
  function goTo(next: number) {
    if (next > step) {
      for (let at = step; at < next; at++) {
        const found = problem(at);
        if (found) {
          setStep(at);
          setStepError(found);
          return;
        }
      }
    }
    setStepError("");
    setStep(next);
    // The review shows the server's total at once.
    if (next === 3 && !quote) void getTotal();
  }

  async function create() {
    if (!quote) return;
    let request;
    try {
      request = validate(manualOrderRequestSchema, {
        contact: { name, phone },
        address: {
          areaId,
          type: address.type,
          building: address.building,
          unit: address.unit || null,
          street: address.street || null,
          makani: address.makani || null,
          notes: address.notes || null,
        },
        // The area travels inside the address; the order request has no top-level area.
        lines: priced().lines,
        couponCode: priced().couponCode,
        quoteToken: quote.quote.token,
        ageConfirmed: age,
        start: startAs,
        ...(startAs === "confirmed" ? { evidence: { channel, note: evidenceNote } } : {}),
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
      toast("Order created");
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

  const area = choices.data?.areas.find((item) => item.id === areaId);
  const units = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const summary = (
    <>
      {lines.length ? (
        <div className="items">
          {lines.map((line) => (
            <div className="it" key={line.choice.variantId}>
              <div>
                <b>{line.choice.productName}</b>
                <small>
                  {choiceLabel(line.choice)} · {line.quantity} × {money(line.choice.unitPriceFils)}
                </small>
              </div>
              <div className="r">
                <b>{money(line.choice.unitPriceFils * (Number(line.quantity) || 0))}</b>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">No products yet.</p>
      )}
      <hr className="hr sum-hr" />
      {quote ? (
        <div className="sum">
          <div>
            <span className="muted">Subtotal</span>
            <span>{money(quote.merchandiseSubtotalFils)}</span>
          </div>
          <div>
            <span className="muted">Discount</span>
            <span className={quote.discountFils ? "neg" : undefined}>
              {quote.discountFils ? `− ${money(quote.discountFils)}` : "—"}
            </span>
          </div>
          <div>
            <span className="muted">Delivery</span>
            <span>{money(quote.deliveryFeeFils)}</span>
          </div>
          <div className="tot">
            <span>Total to collect</span>
            <span>{money(quote.totalFils)}</span>
          </div>
        </div>
      ) : (
        <p className="small muted">
          The total comes from the server on the Review step: delivery, any code and stock are
          checked there.
        </p>
      )}
    </>
  );

  return (
    <div className="stack order-new" data-unsaved-scope>
      <button data-leave type="button" className="backlink" onClick={onCancel}>
        <Icon name="arr-l" size="sm" />
        Orders
      </button>
      <PageHead title="Create order" sub="For orders taken on WhatsApp, by phone or in person." />
      <ResourceNotice resource={choices} compact />
      {/* The prototype's wizard (`wizard`): a done step can be revisited. */}
      <div className="wizard" aria-label="Steps">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            className={`wz ${index < step ? "done" : index === step ? "now" : ""}`}
            disabled={index > step}
            aria-current={index === step ? "step" : undefined}
            // On a phone only the current step shows its name; the others keep theirs here.
            aria-label={`${index + 1}. ${label}`}
            onClick={() => goTo(index)}
          >
            <i />
            <span>
              {index + 1}. {label}
            </span>
          </button>
        ))}
      </div>
      {choices.data && (
        <div className="split">
          <div className="stack">
            {step === 0 && (
              <section className="card" aria-labelledby="no-customer">
                <div className="card-h">
                  <h2 id="no-customer">Find or add the customer</h2>
                </div>
                <div className="card-b form">
                  <div className="field">
                    <label className="label" htmlFor="no-phone">
                      UAE mobile{" "}
                      <span className="req" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <div className="row nowrap-row">
                      <input
                        id="no-phone"
                        className="input mono"
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
                      {canLookUp && (
                        <button
                          type="button"
                          className="btn btn-p"
                          disabled={busy || !phone.trim()}
                          onClick={() => void findCustomer()}
                        >
                          <Icon name="search" />
                          Find customer by phone
                        </button>
                      )}
                    </div>
                    {lookupMessage && (
                      <p className="errm" role="alert">
                        <Icon name="alert" />
                        {lookupMessage}
                      </p>
                    )}
                  </div>
                  {lookup && !lookup.customer && (
                    <div className="note info" role="status">
                      <Icon name="user" />
                      <p>
                        <b>New customer: no orders under {lookup.phone}.</b> Add their name to
                        create the record.
                      </p>
                    </div>
                  )}
                  {lookup?.customer && (
                    <div className="customer-found" role="status">
                      <div className="pick on">
                        <span className="av" aria-hidden="true">
                          {lookup.customer.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="pick-t">
                          <b>Returning customer: {lookup.customer.name}</b>
                          <div className="small muted">
                            {lookup.customer.orderCount} previous{" "}
                            {lookup.customer.orderCount === 1 ? "order" : "orders"}
                            {lookup.customer.lastOrderAt &&
                              ` · last ${new Date(lookup.customer.lastOrderAt).toLocaleDateString("en-GB")}`}
                          </div>
                        </div>
                        <span className="tag ok">
                          <Icon name="check" />
                          Returning
                        </span>
                      </div>
                      {lookup.customer.noShow && (
                        <div className="note warn" role="alert">
                          <Icon name="alert" />
                          <p>Marked as a no-show before: confirm the order with them first.</p>
                        </div>
                      )}
                      {lookup.customer.addresses.length > 0 ? (
                        <ul className="saved-addr" aria-label="Saved addresses">
                          {lookup.customer.addresses.slice(0, 3).map((saved) => (
                            <li key={saved.id}>
                              <span>
                                {[saved.building, saved.unit, saved.street]
                                  .filter(Boolean)
                                  .join(", ")}
                                <small className="muted"> · {saved.areaName}</small>
                              </span>
                              <button
                                type="button"
                                className="btn btn-s btn-sm"
                                onClick={() => applyAddress(saved)}
                              >
                                Use this address
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="help">No saved address.</p>
                      )}
                    </div>
                  )}
                  <div className="field">
                    <label className="label" htmlFor="no-name">
                      Full name{" "}
                      <span className="req" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="no-name"
                      className="input"
                      required
                      maxLength={100}
                      autoComplete="off"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                </div>
              </section>
            )}
            {step === 1 && (
              <section className="card" aria-labelledby="no-products">
                <div className="card-h">
                  <h2 id="no-products">Add products</h2>
                  <span className="sub">
                    {units} {units === 1 ? "unit" : "units"} added
                  </span>
                </div>
                <div className="card-b form">
                  {/* The picker keeps its own markup (parity G-A1) inside the card. */}
                  <div className="management-card in-drawer">
                    <OrderItemPicker
                      taken={new Set(lines.map((line) => line.choice.variantId))}
                      onPick={(choice) => changed(setLines)([...lines, { choice, quantity: "1" }])}
                    />
                  </div>
                  {lines.length > 0 && (
                    <div>
                      <span className="sect-t">In this order</span>
                      <div className="items no-lines" aria-label="In this order">
                        {lines.map((line) => (
                          <div className="it" key={line.choice.variantId}>
                            <div>
                              <b>{line.choice.productName}</b>
                              <small>
                                {line.choice.brandName} · {choiceLabel(line.choice)} ·{" "}
                                {money(line.choice.unitPriceFils)}
                              </small>
                            </div>
                            <div className="r no-line-r">
                              <input
                                className="input qty-input"
                                type="number"
                                min={1}
                                max={10}
                                value={line.quantity}
                                aria-label={`Quantity of ${line.choice.productName}`}
                                onChange={(event) =>
                                  changed(setLines)(
                                    lines.map((entry) =>
                                      entry === line
                                        ? { ...entry, quantity: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                              <button
                                type="button"
                                className="ibtn"
                                aria-label={`Remove ${line.choice.productName}`}
                                onClick={() =>
                                  changed(setLines)(lines.filter((entry) => entry !== line))
                                }
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
            {step === 2 && (
              <section className="card" aria-labelledby="no-delivery">
                <div className="card-h">
                  <h2 id="no-delivery">Delivery details</h2>
                </div>
                <div className="card-b">
                  <div className="fgrid c2">
                    <div className="field">
                      <label className="label" htmlFor="no-area">
                        Area{" "}
                        <span className="req" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <select
                        id="no-area"
                        className="select"
                        required
                        value={areaId}
                        onChange={(event) => changed(setAreaId)(event.target.value)}
                      >
                        <option value="">Choose an area</option>
                        {choices.data.areas.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {EMIRATE_NAMES[item.emirate]}
                          </option>
                        ))}
                      </select>
                      <p className="help">
                        Only areas served now are listed; one flat delivery fee.
                      </p>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="no-type">
                        Address type
                      </label>
                      <select
                        id="no-type"
                        className="select"
                        value={address.type}
                        onChange={(event) => setField("type", event.target.value)}
                      >
                        <option value="apartment">Apartment</option>
                        <option value="villa">Villa</option>
                        <option value="office">Office / Hotel</option>
                      </select>
                    </div>
                    <Text
                      id="no-building"
                      label="Building or villa"
                      required
                      value={address.building}
                      max={150}
                      set={(v) => setField("building", v)}
                    />
                    <Text
                      id="no-unit"
                      label="Unit (not for a villa)"
                      value={address.unit}
                      max={50}
                      set={(v) => setField("unit", v)}
                    />
                    <Text
                      id="no-street"
                      label="Street or landmark"
                      optional
                      value={address.street}
                      max={150}
                      set={(v) => setField("street", v)}
                    />
                    <Text
                      id="no-makani"
                      label="Makani"
                      optional
                      numeric
                      value={address.makani}
                      max={14}
                      set={(v) => setField("makani", v)}
                    />
                    <div className="field span2">
                      <label className="label" htmlFor="no-notes">
                        Delivery notes <span className="opt">Optional</span>
                      </label>
                      <textarea
                        id="no-notes"
                        className="textarea"
                        maxLength={500}
                        rows={2}
                        placeholder="e.g. Call on arrival"
                        value={address.notes}
                        onChange={(event) => setField("notes", event.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}
            {step === 3 && (
              <section className="card" aria-labelledby="no-review">
                <div className="card-h">
                  <h2 id="no-review">Review order</h2>
                  <button type="button" className="btn btn-g btn-sm" onClick={() => goTo(0)}>
                    <Icon name="edit" size="sm" />
                    Edit
                  </button>
                </div>
                <div className="card-b form">
                  <dl className="kv kv-flat">
                    <dt>Customer</dt>
                    <dd>
                      {name}{" "}
                      <span className={lookup?.customer ? "tag ok" : "tag info"}>
                        {lookup?.customer ? "Returning" : "New"}
                      </span>
                    </dd>
                    <dt>Phone</dt>
                    <dd className="mono">{phone}</dd>
                    <dt>Deliver to</dt>
                    <dd>
                      {[address.building, address.unit, address.street].filter(Boolean).join(", ")}
                      {area ? `, ${area.name}` : ""}
                    </dd>
                    {address.notes && (
                      <>
                        <dt>Notes</dt>
                        <dd>{address.notes}</dd>
                      </>
                    )}
                  </dl>
                  <div className="field">
                    <label className="label" htmlFor="no-code">
                      Coupon code <span className="opt">Optional</span>
                    </label>
                    <div className="row nowrap-row">
                      <input
                        id="no-code"
                        className="input mono upper"
                        maxLength={32}
                        value={coupon}
                        onChange={(event) => changed(setCoupon)(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-s"
                        disabled={busy}
                        onClick={() => void getTotal()}
                      >
                        {quote ? "Apply" : "Get total"}
                      </button>
                    </div>
                    <p className="help">Percentage codes only; one code per order.</p>
                  </div>
                  {quote && quote.insufficientStock.length > 0 && (
                    <div className="note err" role="alert">
                      <Icon name="alert" />
                      <p>Not enough stock for {quote.insufficientStock.length} item(s).</p>
                    </div>
                  )}
                  <div className="field">
                    <span className="label">Payment</span>
                    <div className="radios">
                      <label className="ropt">
                        <input type="radio" name="pay" checked readOnly />
                        <span>
                          <b>
                            <Icon name="cash" size="sm" /> Cash on Delivery
                          </b>
                          <small>
                            {quote
                              ? `Courier collects ${money(quote.totalFils)} on delivery.`
                              : "Courier collects the total on delivery."}
                          </small>
                        </span>
                      </label>
                    </div>
                  </div>
                  {canConfirm && (
                    <div className="field">
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={startAs === "confirmed"}
                          onChange={(event) =>
                            setStartAs(event.target.checked ? "confirmed" : "pending")
                          }
                        />
                        Customer already confirmed. Create as <b>Confirmed</b>
                      </label>
                      {startAs === "confirmed" && (
                        <div className="fgrid c2 confirm-evidence">
                          <div className="field">
                            <label className="label" htmlFor="no-channel">
                              Confirmed by
                            </label>
                            <select
                              id="no-channel"
                              className="select"
                              value={channel}
                              onChange={(event) => setChannel(event.target.value as typeof channel)}
                            >
                              {MANUAL_CONFIRMATION_CHANNELS.map((value) => (
                                <option key={value} value={value}>
                                  {CHANNEL_LABELS[value]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <Text
                            id="no-evidence"
                            label="How it was confirmed"
                            value={evidenceNote}
                            max={300}
                            set={setEvidenceNote}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={age}
                      onChange={(event) => setAge(event.target.checked)}
                    />
                    The customer confirmed they are 18 or older.
                  </label>
                </div>
              </section>
            )}
            {stepError && (
              <div className="note err" role="alert">
                <Icon name="alert" />
                <p>{stepError}</p>
              </div>
            )}
            {message && (
              <div className="note err" role="alert">
                <Icon name="alert" />
                <p>{message}</p>
              </div>
            )}
          </div>
          <div className="stack hide-m">
            <section className="card" aria-labelledby="no-summary">
              <div className="card-h">
                <h2 id="no-summary">Order summary</h2>
              </div>
              <div className="card-b">{summary}</div>
            </section>
          </div>
        </div>
      )}
      <div className="savebar">
        <span className="msg">
          <span className="small muted">Total</span>
          <b className="no-total">{quote ? money(quote.totalFils) : "—"}</b>
        </span>
        {step > 0 ? (
          <button type="button" className="btn btn-s" onClick={() => goTo(step - 1)}>
            <Icon name="arr-l" size="sm" />
            Back
          </button>
        ) : (
          <button data-leave type="button" className="btn btn-s" onClick={onCancel}>
            Cancel
          </button>
        )}
        {step < 3 ? (
          <button type="button" className="btn btn-p" onClick={() => goTo(step + 1)}>
            Continue
            <Icon name="arr-r" size="sm" />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || !quote}
            onClick={() => void create()}
          >
            <Icon name="check" />
            {quote ? `Create order · ${money(quote.totalFils)}` : "Getting the total…"}
          </button>
        )}
      </div>
    </div>
  );
}

/** One labelled text field of the prototype's form (`field`). */
function Text({
  id,
  label,
  value,
  set,
  max,
  required = false,
  optional = false,
  numeric = false,
}: {
  id: string;
  label: string;
  value: string;
  set: (value: string) => void;
  max: number;
  required?: boolean;
  optional?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
        {required && (
          <>
            {" "}
            <span className="req" aria-hidden="true">
              *
            </span>
          </>
        )}
        {optional && (
          <>
            {" "}
            <span className="opt">Optional</span>
          </>
        )}
      </label>
      <input
        id={id}
        className="input"
        required={required}
        maxLength={max}
        inputMode={numeric ? "numeric" : undefined}
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </div>
  );
}
