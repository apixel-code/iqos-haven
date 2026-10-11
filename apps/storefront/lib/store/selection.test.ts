import { describe, expect, it } from "vitest";
import { addLine, CART_LIMITS, cartCount, EMPTY_CART, parseCart, type Cart } from "../cart/cart";
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
