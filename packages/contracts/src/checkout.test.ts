import { describe, expect, it } from "vitest";
import {
  CHECKOUT_MESSAGES,
  checkoutAddressSchema,
  checkoutContactSchema,
  orderLinesSchema,
} from "./checkout";
import { customerAddressSchema } from "./customers";
const AREA = "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a35";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** Field → message, the way a form shows them. */
const messages = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) =>
  Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]),
  );
describe("checkout contact", () => {
  it("returns the stored form of what was typed", () => {
    expect(
      checkoutContactSchema.parse({ name: "  Synthetic   Buyer ", phone: "050 123 4567" }),
    ).toEqual({ name: "Synthetic Buyer", phone: "+971501234567" });
  });
  it("reports both fields at once with the form's wording", () => {
    expect(messages(checkoutContactSchema.safeParse({}))).toEqual({
      name: CHECKOUT_MESSAGES.name,
      phone: CHECKOUT_MESSAGES.phoneMissing,
    });
    expect(messages(checkoutContactSchema.safeParse({ name: "A", phone: "04 123 4567" }))).toEqual({
      name: CHECKOUT_MESSAGES.name,
      phone: CHECKOUT_MESSAGES.phone,
    });
    for (const phone of ["+44 20 7946 0958", "050 123 456", "800 1234"])
      expect(messages(checkoutContactSchema.safeParse({ name: "Synthetic", phone }))).toEqual({
        phone: CHECKOUT_MESSAGES.phone,
      });
  });
  it("refuses unknown fields and oversized input", () => {
    expect(
      checkoutContactSchema.safeParse({ name: "Synthetic", phone: "0501234567", email: "x" })
        .success,
    ).toBe(false);
    expect(
      checkoutContactSchema.safeParse({ name: "x".repeat(2001), phone: "0501234567" }).success,
    ).toBe(false);
    expect(
      messages(checkoutContactSchema.safeParse({ name: "x".repeat(101), phone: "0501234567" })),
    ).toEqual({
      name: CHECKOUT_MESSAGES.name,
    });
  });
});
describe("checkout address", () => {
  const apartment = { areaId: AREA, type: "apartment", building: "Synthetic Tower", unit: "2408" };
  it("normalizes text, strips Makani spaces and fits the storage bounds", () => {
    const parsed = checkoutAddressSchema.parse({
      ...apartment,
      areaId: AREA.toUpperCase(),
      building: "  Synthetic   Tower ",
      street: " ",
      makani: "12345 67890",
      notes: " Gate  code 12 ",
    });
    expect(parsed).toEqual({
      areaId: AREA,
      type: "apartment",
      building: "Synthetic Tower",
      unit: "2408",
      street: null,
      makani: "1234567890",
      notes: "Gate code 12",
    });
    expect(customerAddressSchema.parse(parsed)).toEqual(parsed);
  });
  it("requires a unit for an apartment and an office, not for a villa", () => {
    expect(messages(checkoutAddressSchema.safeParse({ ...apartment, unit: "" }))).toEqual({
      unit: CHECKOUT_MESSAGES.unit.apartment,
    });
    expect(
      messages(checkoutAddressSchema.safeParse({ ...apartment, type: "office", unit: null })),
    ).toEqual({
      unit: CHECKOUT_MESSAGES.unit.office,
    });
    expect(
      checkoutAddressSchema.parse({
        areaId: AREA,
        type: "villa",
        building: "Villa 24, Synthetic 7",
      }),
    ).toMatchObject({ type: "villa", unit: null });
    // A villa may still give a unit (an annex, a floor); it is kept as typed.
    expect(
      checkoutAddressSchema.parse({ areaId: AREA, type: "villa", building: "Villa 24", unit: "B" }),
    ).toMatchObject({ unit: "B" });
    expect(checkoutAddressSchema.parse({ ...apartment, makani: "١٢٣٤٥ ٦٧٨٩٠" }).makani).toBe(
      "1234567890",
    );
    expect(messages(checkoutAddressSchema.safeParse({ areaId: AREA, type: "villa" }))).toEqual({
      building: CHECKOUT_MESSAGES.building.villa,
    });
  });
  it("reports every problem in one pass", () => {
    expect(
      messages(
        checkoutAddressSchema.safeParse({
          areaId: "not-an-id",
          type: "hotel",
          building: "x".repeat(151),
          makani: "12345",
          notes: "x".repeat(501),
          street: "bad\u0007street",
        }),
      ),
    ).toEqual({
      areaId: CHECKOUT_MESSAGES.area,
      type: CHECKOUT_MESSAGES.type,
      building: CHECKOUT_MESSAGES.tooLong(150),
      unit: CHECKOUT_MESSAGES.unit.apartment,
      street: CHECKOUT_MESSAGES.characters,
      makani: CHECKOUT_MESSAGES.makani,
      notes: CHECKOUT_MESSAGES.tooLong(500),
    });
    expect(messages(checkoutAddressSchema.safeParse({}))).toEqual({
      areaId: CHECKOUT_MESSAGES.area,
      type: CHECKOUT_MESSAGES.type,
      building: CHECKOUT_MESSAGES.building.apartment,
      unit: CHECKOUT_MESSAGES.unit.apartment,
    });
  });
  it("accepts the bounds exactly and refuses unknown fields", () => {
    expect(
      checkoutAddressSchema.safeParse({
        ...apartment,
        building: "x".repeat(150),
        unit: "x".repeat(50),
        street: "x".repeat(150),
        notes: "x".repeat(500),
      }).success,
    ).toBe(true);
    for (const makani of ["123456789", "12345678901", "12345abcde"])
      expect(messages(checkoutAddressSchema.safeParse({ ...apartment, makani }))).toEqual({
        makani: CHECKOUT_MESSAGES.makani,
      });
    expect(checkoutAddressSchema.safeParse({ ...apartment, feeFils: 0 }).success).toBe(false);
    expect(checkoutAddressSchema.safeParse({ ...apartment, emirate: "sharjah" }).success).toBe(
      false,
    );
  });
});
describe("order lines", () => {
  it("merges, sorts and keeps integer quantities", () => {
    expect(
      orderLinesSchema.parse([
        { variantId: id(2), quantity: 1 },
        { variantId: id(1), quantity: 10 },
        { variantId: id(2), quantity: 2 },
      ]),
    ).toEqual([
      { variantId: id(1), quantity: 10 },
      { variantId: id(2), quantity: 3 },
    ]);
  });
  it("refuses empty, oversized and out-of-range input with a message", () => {
    expect(messages(orderLinesSchema.safeParse([]))).toEqual({ "": CHECKOUT_MESSAGES.linesEmpty });
    expect(messages(orderLinesSchema.safeParse(undefined))).toEqual({
      "": CHECKOUT_MESSAGES.linesEmpty,
    });
    expect(
      messages(
        orderLinesSchema.safeParse(
          Array.from({ length: 51 }, (_, n) => ({ variantId: id(n), quantity: 1 })),
        ),
      ),
    ).toEqual({ "": CHECKOUT_MESSAGES.linesTooMany });
    for (const quantity of [0, -1, 1.5, 11, 1e21])
      expect(messages(orderLinesSchema.safeParse([{ variantId: id(1), quantity }]))).toEqual({
        "0.quantity": CHECKOUT_MESSAGES.quantity,
      });
    expect(messages(orderLinesSchema.safeParse([{ variantId: id(1), quantity: "2" }]))).toEqual({
      "0.quantity": CHECKOUT_MESSAGES.quantity,
    });
    expect(
      messages(
        orderLinesSchema.safeParse([
          { variantId: id(1), quantity: 6 },
          { variantId: id(1), quantity: 5 },
        ]),
      ),
    ).toEqual({ "0.quantity": CHECKOUT_MESSAGES.quantity });
  });
  it("refuses a client price or any other extra field on a line", () => {
    expect(
      orderLinesSchema.safeParse([{ variantId: id(1), quantity: 1, priceFils: 1 }]).success,
    ).toBe(false);
    expect(orderLinesSchema.safeParse([{ variantId: "x", quantity: 1 }]).success).toBe(false);
  });
});
