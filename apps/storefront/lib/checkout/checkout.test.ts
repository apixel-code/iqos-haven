import { describe, expect, it } from "vitest";
import {
  addressLines,
  confirmationView,
  optionText,
  placedText,
  rememberedPlaced,
  rememberPlaced,
  subtotalFils,
} from "./confirmation";
import { ATTEMPT_STORAGE_KEY, attemptFrom, newAttempt, parseAttempt } from "./attempt";
import {
  EMPTY_FORM,
  orderOutcome,
  requestParts,
  serverFieldErrors,
  validateForm,
  type CheckoutForm,
} from "./order";

const AREA = "0199a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b";
const good: CheckoutForm = {
  ...EMPTY_FORM,
  name: "Synthetic Buyer",
  phone: "50 123 4567",
  building: "Synthetic Tower",
  unit: "1204",
  ageConfirmed: true,
};
const envelope = (code: string, fields: unknown[] = []) => ({
  error: { code, message: "m", requestId: "r", fields },
});

describe("checkout attempt key", () => {
  it("makes a 256-bit URL-safe key the API accepts, with only its creation time", () => {
    const attempt = newAttempt(new Date("2026-10-13T08:00:00Z"), (bytes) => bytes.fill(255));
    expect(attempt).toEqual({ key: "_".repeat(42) + "8", createdAt: "2026-10-13T08:00:00.000Z" });
    expect(attempt.key).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(Object.keys(attempt)).toEqual(["key", "createdAt"]);
    let n = 0;
    const other = newAttempt(new Date(), (bytes) => bytes.map(() => n++));
    expect(other.key).not.toBe(attempt.key);
    expect(parseAttempt(JSON.stringify(other))).toEqual(other);
  });

  it("reads back only an exact attempt and never repairs anything else", () => {
    const key = "A".repeat(43);
    const createdAt = "2026-10-13T08:00:00.000Z";
    expect(parseAttempt(JSON.stringify({ key, createdAt }))).toEqual({ key, createdAt });
    // Anything stored next to it (a name, a phone) is not read back.
    expect(parseAttempt(JSON.stringify({ key, createdAt, phone: "0501234567" }))).toEqual({
      key,
      createdAt,
    });
    for (const text of [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify({ key: "short", createdAt }),
      JSON.stringify({ key: key + "!", createdAt }),
      JSON.stringify({ key, createdAt: "yesterday" }),
      JSON.stringify({ key }),
      "x".repeat(500),
    ])
      expect(parseAttempt(text)).toBeNull();
  });
});

describe("where the attempt key is kept", () => {
  const first = { key: "A".repeat(43), createdAt: "2026-10-13T08:00:00.000Z" };
  const second = { key: "B".repeat(43), createdAt: "2026-10-13T09:00:00.000Z" };
  const store = (initial?: string) => {
    const items = new Map<string, string>(initial ? [[ATTEMPT_STORAGE_KEY, initial]] : []);
    return {
      items,
      open: () => ({
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
      }),
    };
  };
  const blocked = () => {
    throw new Error("SecurityError");
  };
  const never = () => {
    throw new Error("must not make a key");
  };

  it("reuses the stored key and makes one only when none is open", () => {
    const local = store(JSON.stringify(first));
    expect(attemptFrom([local.open, blocked], null, never)).toEqual({
      attempt: first,
      stored: true,
    });
    const empty = store();
    expect(attemptFrom([empty.open], null, () => second)).toEqual({
      attempt: second,
      stored: true,
    });
    expect(parseAttempt(empty.items.get(ATTEMPT_STORAGE_KEY)!)).toEqual(second);
    // Storage that can be read and is empty: the attempt was finished elsewhere, so a key
    // remembered by this page is not brought back.
    expect(attemptFrom([store().open], first, () => second).attempt).toEqual(second);
  });

  it("falls back to the next store, and to the page only when every store is blocked", () => {
    const session = store();
    expect(attemptFrom([blocked, session.open], null, () => first)).toEqual({
      attempt: first,
      stored: true,
    });
    // After a reload the key is found there again.
    expect(attemptFrom([blocked, session.open], null, never).attempt).toEqual(first);
    expect(attemptFrom([blocked, blocked], null, () => first)).toEqual({
      attempt: first,
      stored: false,
    });
    // Nothing readable: the page keeps using the key it made, so a retry is still safe.
    expect(attemptFrom([blocked, blocked], first, never).attempt).toEqual(first);
  });
});

describe("checkout form", () => {
  it("accepts a complete form and reports every problem at once", () => {
    expect(validateForm(good, AREA)).toEqual({});
    expect(validateForm(EMPTY_FORM, "")).toEqual({
      name: "Enter your full name",
      phone: "Enter your mobile number",
      areaId: "Select your area",
      building: "Enter your building name",
      unit: "Enter your apartment number",
      ageConfirmed: "Confirm you are 18 or older",
    });
    expect(validateForm({ ...good, phone: "04 123 4567", makani: "123" }, AREA)).toEqual({
      phone: "Enter a UAE mobile number, e.g. 50 123 4567",
      makani: "Makani numbers have 10 digits, or leave this blank",
    });
    expect(validateForm({ ...good, type: "office", unit: "" }, AREA).unit).toBe(
      "Enter your office or room number",
    );
  });

  it("needs no unit for a villa and does not send one typed earlier", () => {
    const villa = { ...good, type: "villa" as const, building: "Villa 24, Springs 7" };
    expect(validateForm({ ...villa, unit: "" }, AREA)).toEqual({});
    expect(requestParts(villa, AREA).address.unit).toBeNull();
    expect(validateForm({ ...villa, building: "" }, AREA).building).toBe(
      "Enter your villa number and community",
    );
  });

  it("turns the fields the API names into messages without needing what was typed back", () => {
    expect(
      serverFieldErrors(
        [{ path: "contact.phone" }, { path: "address.notes" }, { path: "x" }],
        good,
        AREA,
      ),
    ).toEqual({
      phone: "Enter a UAE mobile number, e.g. 50 123 4567",
      notes: "Check this field",
    });
    expect(
      serverFieldErrors([{ path: "ageConfirmed" }], { ...good, ageConfirmed: false }, AREA),
    ).toEqual({ ageConfirmed: "Confirm you are 18 or older" });
  });
});

describe("order route answers", () => {
  const placed = {
    orderNumber: "IH-001001",
    totalFils: 15900,
    placedAt: "2026-10-13T08:00:00.000Z",
  };

  it("counts only a readable 201 as an acknowledged order", () => {
    expect(orderOutcome(201, placed)).toEqual({ kind: "placed", order: placed });
    // Unreadable acknowledgement: ask again with the same key, never treat it as a failure.
    expect(orderOutcome(201, { orderNumber: "IH-001001" })).toEqual({
      kind: "uncertain",
      reason: "UNAVAILABLE",
    });
    expect(orderOutcome(200, placed).kind).toBe("uncertain");
  });

  it("keeps the same key for every answer that does not settle the attempt", () => {
    expect(orderOutcome(409, envelope("IDEMPOTENCY_IN_PROGRESS"))).toEqual({
      kind: "uncertain",
      reason: "BUSY",
    });
    expect(orderOutcome(429, envelope("RATE_LIMITED"))).toEqual({
      kind: "uncertain",
      reason: "LIMITED",
    });
    for (const [status, body] of [
      [503, envelope("SERVICE_UNAVAILABLE")],
      [503, envelope("TRANSACTION_RETRY_EXHAUSTED")],
      [500, envelope("INTERNAL_ERROR")],
      [502, null],
      [409, envelope("SOMETHING_NEW")],
      [409, "<html>"],
    ] as const)
      expect(orderOutcome(status, body)).toEqual({ kind: "uncertain", reason: "UNAVAILABLE" });
  });

  it("never reads an old or reused key as a new order", () => {
    for (const code of ["CHECKOUT_RECOVERY_REQUIRED", "IDEMPOTENCY_CONFLICT"])
      expect(orderOutcome(409, envelope(code))).toEqual({ kind: "already_placed" });
  });

  it("sends the shopper back to the total, the cart or the form for the rest", () => {
    for (const reason of [
      "QUOTE_CHANGED",
      "QUOTE_EXPIRED",
      "INSUFFICIENT_STOCK",
      "COUPON_INVALID",
      "COUPON_LIMIT_REACHED",
    ])
      expect(orderOutcome(409, envelope(reason))).toEqual({ kind: "requote", reason });
    for (const reason of ["AREA_UNAVAILABLE", "VARIANT_UNAVAILABLE"])
      expect(orderOutcome(409, envelope(reason))).toEqual({ kind: "blocked", reason });
    expect(orderOutcome(403, envelope("AGE_VERIFICATION_REQUIRED"))).toEqual({
      kind: "blocked",
      reason: "AGE",
    });
    expect(
      orderOutcome(
        400,
        envelope("VALIDATION_ERROR", [{ path: "contact.name", message: "Invalid field" }, 7]),
      ),
    ).toEqual({ kind: "invalid", fields: [{ path: "contact.name", message: "Invalid field" }] });
  });
});

describe("order confirmation", () => {
  const order = {
    orderNumber: "IH-001001",
    placedAt: "2026-10-13T08:05:00.000Z",
    status: "pending" as const,
    totalFils: 15900,
    deliveryFeeFils: 1500,
    discountFils: 1600,
    etaText: "Synthetic ETA",
    address: {
      area: "Synthetic Area",
      emirate: "sharjah",
      type: "apartment" as const,
      building: "Synthetic Tower",
      unit: "1204",
      street: null,
    },
    items: [
      {
        name: "Synthetic Kit",
        attributes: { flavour: "Grape", strength: "20 mg" },
        quantity: 2,
        unitPriceFils: 8000,
        totalFils: 14400,
      },
    ],
  };

  it("shows only a snapshot that matches the contract", () => {
    expect(confirmationView(200, order)).toEqual({ kind: "shown", order });
    // Anything extra (a name, a phone) or missing is not an order to show.
    expect(confirmationView(200, { ...order, customerPhone: "+971501234567" })).toEqual({
      kind: "failed",
      limited: false,
    });
    expect(confirmationView(200, null).kind).toBe("failed");
  });

  it("tells expired access from a page that could not ask", () => {
    expect(confirmationView(401, { error: { code: "UNAUTHENTICATED" } })).toEqual({
      kind: "expired",
    });
    expect(confirmationView(429, null)).toEqual({ kind: "failed", limited: true });
    expect(confirmationView(503, null)).toEqual({ kind: "failed", limited: false });
    expect(confirmationView(403, null).kind).toBe("failed");
  });

  it("words the snapshot from the API's own amounts", () => {
    // 159.00 total − 15.00 delivery + 16.00 discount = 160.00 of items.
    expect(subtotalFils(order)).toBe(16000);
    expect(addressLines(order.address)).toEqual([
      "Apartment 1204, Synthetic Tower",
      "Synthetic Area, Sharjah",
    ]);
    expect(
      addressLines({
        ...order.address,
        type: "villa",
        unit: null,
        building: "Villa 24",
        street: "Near the park",
      }),
    ).toEqual(["Villa 24", "Near the park", "Synthetic Area, Sharjah"]);
    expect(optionText(order.items[0]!.attributes)).toBe("Grape · 20 mg");
    // UAE time, whatever the device is set to.
    expect(placedText(order.placedAt)).toBe("13 Oct 2026, 12:05");
  });

  it("remembers the acknowledged order for this visit only, as number, total and time", () => {
    expect(rememberedPlaced()).toBeNull();
    const placed = { orderNumber: "IH-001001", totalFils: 15900, placedAt: order.placedAt };
    rememberPlaced(placed);
    expect(rememberedPlaced()).toEqual(placed);
  });
});
