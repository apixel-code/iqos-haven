import { z } from "zod";

/**
 * Device cart (roadmap steps 61–62, ADR 0030). A list of variant IDs and quantities with a
 * small display snapshot, kept on this device only. It never holds a name, phone, address or
 * anything about the shopper, and the prices in it are a preview: the server quote decides what
 * is charged and whether a line can still be bought.
 */
export const CART_STORAGE_KEY = "ih_cart_v1";
export const CART_LIMITS = { maxLines: 50, maxQuantity: 10 } as const;

const lineSchema = z.strictObject({
  variantId: z.uuid(),
  productSlug: z.string().min(1).max(150),
  quantity: z.number().int().min(1).max(CART_LIMITS.maxQuantity),
  /** What the shopper saw when adding; for display until the cart refreshes it. */
  snapshot: z.strictObject({
    name: z.string().max(150),
    brand: z.string().max(150),
    options: z.string().max(400),
    priceFils: z.number().int().min(0).max(1_000_000_000),
  }),
});
const cartSchema = z.strictObject({
  v: z.literal(1),
  lines: z.array(lineSchema).max(CART_LIMITS.maxLines),
});
export type CartLine = z.infer<typeof lineSchema>;
export type Cart = z.infer<typeof cartSchema>;

export const EMPTY_CART: Cart = { v: 1, lines: [] };

/** Reads stored text; anything unreadable or off-schema is an empty cart, never an error. */
export function parseCart(text: string | null): Cart {
  if (!text) return EMPTY_CART;
  try {
    const parsed = cartSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return EMPTY_CART;
    // One line per variant: a repeated ID (hand-edited storage) keeps its first line.
    const seen = new Set<string>();
    const lines = parsed.data.lines.filter(
      (line) => !seen.has(line.variantId) && seen.add(line.variantId),
    );
    return lines.length === parsed.data.lines.length ? parsed.data : { v: 1, lines };
  } catch {
    return EMPTY_CART;
  }
}

export type AddResult = {
  cart: Cart;
  /** Quantity of this variant in the cart afterwards. */
  quantity: number;
  /** True when the per-item limit stopped part or all of the addition. */
  capped: boolean;
  /** True when the cart already holds the maximum number of different items. */
  full: boolean;
};

/** Adds a variant; the same variant merges into one line, up to the per-item limit. */
export function addLine(cart: Cart, line: Omit<CartLine, "quantity">, quantity: number): AddResult {
  const wanted = Math.max(1, Math.min(CART_LIMITS.maxQuantity, Math.trunc(quantity) || 1));
  const existing = cart.lines.find((item) => item.variantId === line.variantId);
  if (!existing && cart.lines.length >= CART_LIMITS.maxLines)
    return { cart, quantity: 0, capped: false, full: true };
  const total = Math.min(CART_LIMITS.maxQuantity, (existing?.quantity ?? 0) + wanted);
  const next: CartLine = { ...line, quantity: total };
  return {
    cart: {
      v: 1,
      lines: existing
        ? cart.lines.map((item) => (item.variantId === line.variantId ? next : item))
        : [...cart.lines, next],
    },
    quantity: total,
    capped: total < (existing?.quantity ?? 0) + wanted,
    full: false,
  };
}

export const cartCount = (cart: Cart) => cart.lines.reduce((sum, line) => sum + line.quantity, 0);

/** Sets one line's quantity (1 to the per-item limit). Unknown variants leave the cart as is. */
export function setLineQuantity(cart: Cart, variantId: string, quantity: number): Cart {
  const next = Math.max(1, Math.min(CART_LIMITS.maxQuantity, Math.trunc(quantity) || 1));
  if (!cart.lines.some((line) => line.variantId === variantId && line.quantity !== next))
    return cart;
  return {
    v: 1,
    lines: cart.lines.map((line) =>
      line.variantId === variantId ? { ...line, quantity: next } : line,
    ),
  };
}

export function removeLine(cart: Cart, variantId: string): Cart {
  if (!cart.lines.some((line) => line.variantId === variantId)) return cart;
  return { v: 1, lines: cart.lines.filter((line) => line.variantId !== variantId) };
}

/** What the server currently says about a variant (subset of the cart-lines response). */
export interface FreshLine {
  variantId: string;
  productSlug: string;
  name: string;
  brand: string;
  options: string;
  priceFils: number;
  available: boolean;
}

export type LineStatus =
  /** Confirmed by the server just now. */
  | "ok"
  | "sold_out"
  /** The server no longer offers this variant (deactivated, unpublished or removed). */
  | "unavailable"
  /** Not confirmed yet, or the refresh failed: shown from the device snapshot. */
  | "unconfirmed";

export interface CartViewLine {
  variantId: string;
  productSlug: string;
  name: string;
  brand: string;
  options: string;
  quantity: number;
  status: LineStatus;
  unitPriceFils: number;
  lineTotalFils: number;
  /** The price differs from what the shopper saw when adding (snapshot fils), else null. */
  previousUnitPriceFils: number | null;
}
export interface CartView {
  lines: CartViewLine[];
  /** Units in lines that can currently be bought (or are not yet confirmed). */
  itemCount: number;
  /** Preview only: sum of buyable lines in fils. Delivery and the final total come at checkout. */
  subtotalFils: number;
  /** Lines that cannot be bought as they are; they are never replaced by another variant. */
  blockedCount: number;
  /** Every line has a server answer. */
  confirmed: boolean;
}

/**
 * What is known about the cart's variants: the latest server answer per variant ID. A key with
 * `null` means the server was asked and did not return it (no longer offered). A variant with no
 * key has never been confirmed.
 */
export type CartKnowledge = ReadonlyMap<string, FreshLine | null>;

/**
 * The cart as the shopper should see it. A variant the server did not return is unavailable; it
 * stays in the cart, flagged, until the shopper removes it. What the server said about a variant
 * keeps applying while that variant is in the cart, so changing another line can never make a
 * sold-out or withdrawn line look buyable again. Integer fils throughout.
 */
export function cartView(cart: Cart, known: CartKnowledge): CartView {
  const lines = cart.lines.map((line): CartViewLine => {
    const current = known.get(line.variantId) ?? undefined;
    const status: LineStatus = !known.has(line.variantId)
      ? "unconfirmed"
      : !current
        ? "unavailable"
        : current.available
          ? "ok"
          : "sold_out";
    const unitPriceFils = current ? current.priceFils : line.snapshot.priceFils;
    return {
      variantId: line.variantId,
      productSlug: current?.productSlug ?? line.productSlug,
      name: current?.name ?? line.snapshot.name,
      brand: current?.brand ?? line.snapshot.brand,
      options: current?.options ?? line.snapshot.options,
      quantity: line.quantity,
      status,
      unitPriceFils,
      lineTotalFils: unitPriceFils * line.quantity,
      previousUnitPriceFils:
        current && current.priceFils !== line.snapshot.priceFils ? line.snapshot.priceFils : null,
    };
  });
  const buyable = lines.filter((line) => line.status === "ok" || line.status === "unconfirmed");
  return {
    lines,
    itemCount: buyable.reduce((sum, line) => sum + line.quantity, 0),
    subtotalFils: buyable.reduce((sum, line) => sum + line.lineTotalFils, 0),
    blockedCount: lines.length - buyable.length,
    confirmed: lines.every((line) => line.status !== "unconfirmed"),
  };
}
