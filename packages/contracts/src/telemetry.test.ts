import { describe, expect, it } from "vitest";
import { normalizeSearchTerm, storeEventsRequestSchema } from "./telemetry";

const ID = "0199e0a0-0000-7000-8000-000000000001";
describe("browsing events (step 103)", () => {
  it("normalizes search terms and keeps nothing that may be personal", () => {
    expect(normalizeSearchTerm("  Grape   ICE ")).toBe("grape ice");
    expect(normalizeSearchTerm("lune 18k")).toBe("lune 18k");
    expect(normalizeSearchTerm("12000 puffs")).toBe("12000 puffs");
    for (const personal of ["050 123 4567", "+971501234567", "someone@example.com", "​"])
      expect(normalizeSearchTerm(personal), personal).toBeNull();
  });

  it("accepts the six shapes only, with bounded batches and no extra fields", () => {
    const ok = storeEventsRequestSchema.safeParse({
      events: [
        { id: ID, type: "search", term: "grape", resultCount: 3 },
        { id: ID, type: "product_view", productSlug: "lune-air" },
        { id: ID, type: "cart_add", variantId: ID, quantity: 2 },
        { id: ID, type: "wishlist_remove", productSlug: "lune-air" },
      ],
    });
    expect(ok.success).toBe(true);
    for (const events of [
      [],
      Array(21).fill({ id: ID, type: "product_view", productSlug: "x" }),
      [{ id: ID, type: "checkout", productSlug: "x" }],
      [{ id: ID, type: "product_view", productSlug: "x", phone: "0501234567" }],
      [{ id: ID, type: "cart_add", variantId: ID, quantity: 0 }],
      [{ id: ID, type: "product_view", productSlug: "Not A Slug" }],
      [{ id: "not-a-uuid", type: "product_view", productSlug: "x" }],
    ])
      expect(storeEventsRequestSchema.safeParse({ events }).success).toBe(false);
    expect(
      storeEventsRequestSchema.safeParse({
        events: [{ id: ID, type: "product_view", productSlug: "x" }],
        name: "Sam",
      }).success,
    ).toBe(false);
  });
});
