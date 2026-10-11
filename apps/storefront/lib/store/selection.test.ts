import { describe, expect, it } from "vitest";
import {
  addLine,
  CART_LIMITS,
  cartCount,
  cartView,
  EMPTY_CART,
  parseCart,
  removeLine,
  setLineQuantity,
  type Cart,
} from "../cart/cart";
import {
  impliedChoices,
  offeredOptions,
  optionLabel,
  resolveSelection,
  valueState,
  variantLabel,
  type Variant,
} from "./selection";

let next = 0;
const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
const variant = (
  attributes: Record<string, string>,
  available = true,
  priceFils = 4900,
): Variant => ({
  id: id(),
  attributes,
  isDefault: false,
  priceFils,
  compareAtPriceFils: null,
  available,
});
const product = {
  options: [
    { name: "flavour", values: ["grape ice", "mint", "peach", "retired"] },
    { name: "nicotine", values: ["20 mg", "50 mg"] },
  ],
  variants: [
    variant({ flavour: "grape ice", nicotine: "20 mg" }),
    variant({ flavour: "grape ice", nicotine: "50 mg" }, true, 5200),
    variant({ flavour: "mint", nicotine: "20 mg" }, false),
    variant({ flavour: "mint", nicotine: "50 mg" }),
    // Peach exists only in 20 mg, and is sold out.
    variant({ flavour: "peach", nicotine: "20 mg" }, false),
  ],
};

describe("option selection", () => {
  it("offers only values an active variant has", () => {
    expect(offeredOptions(product)).toEqual([
      { name: "flavour", values: ["grape ice", "mint", "peach"] },
      { name: "nicotine", values: ["20 mg", "50 mg"] },
    ]);
  });

  it("chooses nothing for the shopper when there is a real choice", () => {
    expect(impliedChoices(offeredOptions(product))).toEqual({});
    expect(resolveSelection(product, {})).toEqual({
      status: "incomplete",
      missing: ["flavour", "nicotine"],
    });
    expect(resolveSelection(product, { flavour: "mint" })).toEqual({
      status: "incomplete",
      missing: ["nicotine"],
    });
  });

  it("fills in an option that has a single value, because that is not a choice", () => {
    const single = {
      options: [
        { name: "flavour", values: ["grape", "mint"] },
        { name: "nicotine", values: ["20 mg"] },
      ],
      variants: [
        variant({ flavour: "grape", nicotine: "20 mg" }),
        variant({ flavour: "mint", nicotine: "20 mg" }),
      ],
    };
    expect(impliedChoices(offeredOptions(single))).toEqual({ nicotine: "20 mg" });
    expect(resolveSelection(single, { nicotine: "20 mg" })).toEqual({
      status: "incomplete",
      missing: ["flavour"],
    });
  });

  it("resolves exactly the chosen variant, with its own price", () => {
    const result = resolveSelection(product, { flavour: "grape ice", nicotine: "50 mg" });
    expect(result).toMatchObject({ status: "ready", variant: { priceFils: 5200 } });
    expect(result.status === "ready" && result.variant.attributes).toEqual({
      flavour: "grape ice",
      nicotine: "50 mg",
    });
  });

  it("never substitutes: a sold-out or unoffered choice is reported, not replaced", () => {
    const soldOut = resolveSelection(product, { flavour: "mint", nicotine: "20 mg" });
    expect(soldOut.status).toBe("sold_out");
    // Mint 50 mg is in stock, but the shopper asked for 20 mg.
    expect(soldOut.status === "sold_out" && soldOut.variant.attributes.nicotine).toBe("20 mg");
    // Peach 50 mg does not exist; peach 20 mg must not be offered in its place.
    expect(resolveSelection(product, { flavour: "peach", nicotine: "50 mg" })).toEqual({
      status: "unavailable",
    });
    // A value that is not on offer at all.
    expect(resolveSelection(product, { flavour: "retired", nicotine: "20 mg" })).toEqual({
      status: "unavailable",
    });
    expect(resolveSelection(product, { flavour: "MINT", nicotine: "20 mg" }).status).toBe(
      "unavailable",
    );
  });

  it("describes each value in the light of the other choices", () => {
    const state = (chosen: Record<string, string>, name: string, value: string) =>
      valueState(product.variants, chosen, name, value);
    expect(state({}, "flavour", "mint")).toBe("available");
    expect(state({}, "flavour", "peach")).toBe("sold_out");
    expect(state({ nicotine: "20 mg" }, "flavour", "mint")).toBe("sold_out");
    expect(state({ nicotine: "50 mg" }, "flavour", "mint")).toBe("available");
    expect(state({ nicotine: "50 mg" }, "flavour", "peach")).toBe("not_offered");
    // Changing the flavour itself is judged without the current flavour.
    expect(state({ flavour: "peach" }, "flavour", "grape ice")).toBe("available");
    expect(state({ flavour: "peach" }, "nicotine", "50 mg")).toBe("not_offered");
  });

  it("handles a product without options as its single variant", () => {
    const plain = { options: [], variants: [variant({})] };
    expect(resolveSelection(plain, {})).toMatchObject({ status: "ready" });
    const gone = { options: [], variants: [variant({}, false)] };
    expect(resolveSelection(gone, {}).status).toBe("sold_out");
  });

  it("offers nothing when the choices do not single out one variant", () => {
    // Two variants the options cannot tell apart: picking either would be a guess.
    const ambiguous = { options: [], variants: [variant({}), variant({})] };
    expect(resolveSelection(ambiguous, {})).toEqual({ status: "unavailable" });
    const undescribed = {
      options: [{ name: "flavour", values: ["mint"] }],
      variants: [
        variant({ flavour: "mint", nicotine: "20 mg" }),
        variant({ flavour: "mint", nicotine: "50 mg" }),
      ],
    };
    expect(resolveSelection(undescribed, { flavour: "mint" })).toEqual({ status: "unavailable" });
  });

  it("labels options and variants for display", () => {
    expect(optionLabel("flavour")).toBe("Flavour");
    expect(optionLabel("pod_colour")).toBe("Pod colour");
    expect(variantLabel(product, { nicotine: "20 mg", flavour: "mint" })).toBe("mint · 20 mg");
    expect(variantLabel({ options: [] }, {})).toBe("");
  });
});

describe("device cart", () => {
  const line = (variantId = id()) => ({
    variantId,
    productSlug: "orbe-halo",
    snapshot: { name: "Halo 7K", brand: "Orbe", options: "mint · 20 mg", priceFils: 4900 },
  });

  it("adds a variant and merges the same variant into one line", () => {
    const item = line();
    const first = addLine(EMPTY_CART, item, 2);
    expect(first).toMatchObject({ quantity: 2, capped: false, full: false });
    const second = addLine(first.cart, item, 3);
    expect(second.cart.lines).toHaveLength(1);
    expect(second.quantity).toBe(5);
    const other = addLine(second.cart, line(), 1);
    expect(other.cart.lines).toHaveLength(2);
    expect(cartCount(other.cart)).toBe(6);
  });

  it("caps one item at the limit and says so", () => {
    const item = line();
    const full = addLine(addLine(EMPTY_CART, item, 8).cart, item, 5);
    expect(full).toMatchObject({ quantity: CART_LIMITS.maxQuantity, capped: true });
    expect(addLine(EMPTY_CART, item, 999).quantity).toBe(CART_LIMITS.maxQuantity);
    for (const bad of [0, -3, Number.NaN, 1.9])
      expect(addLine(EMPTY_CART, item, bad).quantity).toBe(1);
  });

  it("refuses a new item when the cart holds the maximum number of different items", () => {
    let cart: Cart = EMPTY_CART;
    for (let index = 0; index < CART_LIMITS.maxLines; index++) cart = addLine(cart, line(), 1).cart;
    const refused = addLine(cart, line(), 1);
    expect(refused).toMatchObject({ full: true, quantity: 0 });
    expect(refused.cart).toBe(cart);
    // An item already in the cart can still be increased.
    expect(addLine(cart, { ...line(cart.lines[0]!.variantId) }, 1).full).toBe(false);
  });

  it("stores only variant references and a display snapshot, and survives bad storage", () => {
    const stored = JSON.stringify(addLine(EMPTY_CART, line(), 1).cart);
    expect(parseCart(stored).lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(stored).lines[0]).sort()).toEqual([
      "productSlug",
      "quantity",
      "snapshot",
      "variantId",
    ]);
    for (const bad of [
      null,
      "",
      "not json",
      "[]",
      '{"v":2,"lines":[]}',
      '{"v":1,"lines":[{"variantId":"x","quantity":1}]}',
      // Anything personal would make the whole value invalid, not get carried along.
      JSON.stringify({ v: 1, lines: [], phone: "+971500000000" }),
      JSON.stringify({ v: 1, lines: [{ ...JSON.parse(stored).lines[0], address: "x" }] }),
      JSON.stringify({ v: 1, lines: [{ ...JSON.parse(stored).lines[0], quantity: 99 }] }),
    ])
      expect(parseCart(bad), String(bad)).toEqual(EMPTY_CART);
  });
});

describe("cart editing and view", () => {
  const A = "00000000-0000-4000-8000-0000000000a1";
  const B = "00000000-0000-4000-8000-0000000000b2";
  const C = "00000000-0000-4000-8000-0000000000c3";
  const stored = (variantId: string, quantity: number, priceFils: number) => ({
    variantId,
    productSlug: "halo",
    quantity,
    snapshot: { name: "Halo 7K", brand: "Orbe", options: "mint · 20 mg", priceFils },
  });
  const cart: Cart = { v: 1, lines: [stored(A, 2, 4900), stored(B, 1, 2500), stored(C, 3, 1000)] };
  const fresh = (variantId: string, priceFils: number, available = true) => ({
    variantId,
    productSlug: "halo-renamed",
    name: "Halo 7K Pro",
    brand: "Orbe",
    options: "mint · 20 mg",
    priceFils,
    available,
  });

  /** Server answers by variant; `null` = asked and not returned. */
  const known = (...entries: Array<[string, ReturnType<typeof fresh> | null]>) => new Map(entries);

  it("sets a quantity within the limits and removes a line", () => {
    expect(setLineQuantity(cart, A, 5).lines[0]!.quantity).toBe(5);
    expect(setLineQuantity(cart, A, 99).lines[0]!.quantity).toBe(CART_LIMITS.maxQuantity);
    expect(setLineQuantity(cart, A, 0).lines[0]!.quantity).toBe(1);
    // Nothing to change: the same object comes back, so nothing is rewritten.
    expect(setLineQuantity(cart, A, 2)).toBe(cart);
    expect(setLineQuantity(cart, "unknown", 4)).toBe(cart);
    expect(removeLine(cart, B).lines.map((line) => line.variantId)).toEqual([A, C]);
    expect(removeLine(cart, "unknown")).toBe(cart);
  });

  it("shows the device snapshot, unconfirmed, until the server has answered", () => {
    const view = cartView(cart, known());
    expect(view.confirmed).toBe(false);
    expect(view.lines.map((line) => line.status)).toEqual([
      "unconfirmed",
      "unconfirmed",
      "unconfirmed",
    ]);
    expect(view.subtotalFils).toBe(2 * 4900 + 2500 + 3 * 1000);
    expect(view.itemCount).toBe(6);
  });

  it("uses the server's price and name, flags changes, and keeps integer fils", () => {
    const view = cartView(
      cart,
      known([A, fresh(A, 5200)], [B, fresh(B, 2500)], [C, fresh(C, 1000)]),
    );
    expect(view.confirmed).toBe(true);
    expect(view.lines[0]).toMatchObject({
      status: "ok",
      name: "Halo 7K Pro",
      productSlug: "halo-renamed",
      unitPriceFils: 5200,
      lineTotalFils: 10400,
      previousUnitPriceFils: 4900,
    });
    expect(view.lines[1]!.previousUnitPriceFils).toBeNull();
    expect(view.subtotalFils).toBe(10400 + 2500 + 3000);
    expect(Number.isInteger(view.subtotalFils)).toBe(true);
    expect(view.blockedCount).toBe(0);
  });

  it("keeps sold-out and withdrawn lines visible, flagged and out of the subtotal", () => {
    // B is sold out; C is not returned at all (deactivated, unpublished or removed).
    const view = cartView(cart, known([A, fresh(A, 4900)], [B, fresh(B, 2500, false)], [C, null]));
    expect(view.lines.map((line) => [line.variantId, line.status])).toEqual([
      [A, "ok"],
      [B, "sold_out"],
      [C, "unavailable"],
    ]);
    // The withdrawn line still shows what the shopper added, from the device snapshot.
    expect(view.lines[2]).toMatchObject({ name: "Halo 7K", quantity: 3, unitPriceFils: 1000 });
    expect(view.blockedCount).toBe(2);
    expect(view.itemCount).toBe(2);
    expect(view.subtotalFils).toBe(2 * 4900);
    // Nothing is substituted: the view has exactly the cart's variants, in the cart's order.
    expect(view.lines.map((line) => line.variantId)).toEqual(
      cart.lines.map((line) => line.variantId),
    );
  });

  it("keeps a line flagged when another line changes and nothing new is known", () => {
    // The server said: A fine, B sold out, C withdrawn. The shopper then removes C and adds D.
    const answers = known([A, fresh(A, 4900)], [B, fresh(B, 2500, false)], [C, null]);
    const D = "00000000-0000-4000-8000-0000000000d4";
    const changed: Cart = {
      v: 1,
      lines: [stored(A, 2, 4900), stored(B, 1, 2500), stored(D, 1, 700)],
    };
    const view = cartView(changed, answers);
    expect(view.lines.map((line) => line.status)).toEqual(["ok", "sold_out", "unconfirmed"]);
    // B is still not counted; only the new, unconfirmed line is shown from its snapshot.
    expect(view.subtotalFils).toBe(2 * 4900 + 700);
    expect(view.blockedCount).toBe(1);
    expect(view.confirmed).toBe(false);
  });

  it("drops repeated variant IDs from stored text, keeping the first line", () => {
    const text = JSON.stringify({
      v: 1,
      lines: [stored(A, 2, 4900), stored(B, 1, 2500), stored(A, 9, 1)],
    });
    expect(parseCart(text).lines.map((line) => [line.variantId, line.quantity])).toEqual([
      [A, 2],
      [B, 1],
    ]);
  });

  it("ignores server lines the cart does not hold", () => {
    const view = cartView(
      { v: 1, lines: [stored(A, 1, 4900)] },
      known([A, fresh(A, 4900)], [B, fresh(B, 1)]),
    );
    expect(view.lines).toHaveLength(1);
    expect(view.subtotalFils).toBe(4900);
  });

  it("handles an empty cart", () => {
    expect(cartView(EMPTY_CART, known())).toMatchObject({
      lines: [],
      subtotalFils: 0,
      itemCount: 0,
    });
  });
});
