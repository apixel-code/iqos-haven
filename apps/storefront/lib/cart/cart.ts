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
    return parsed.success ? parsed.data : EMPTY_CART;
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
