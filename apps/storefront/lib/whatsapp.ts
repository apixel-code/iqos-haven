import { displayAed } from "./store/listing";

/**
 * WhatsApp links (roadmap step 64, architecture §2: "context-aware wa.me links"). A link only
 * opens WhatsApp with a message the shopper can read and edit before sending: nothing is sent by
 * the site, and no message is ever built from anything the shopper typed at checkout.
 * The number comes from the Owner's settings; the wording below is the prototype's and awaits
 * the client's approved templates (business input BI-09).
 */
const NUMBER = /^\+[1-9]\d{7,14}$/;
const MAX_MESSAGE = 1000;

/** `https://wa.me/<digits>?text=…`, or null when no valid number is configured. */
export function whatsappHref(number: string | null | undefined, message: string): string | null {
  if (!number || !NUMBER.test(number)) return null;
  const text = message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
  return `https://wa.me/${number.slice(1)}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export const WHATSAPP_MESSAGES = {
  general: (store: string) => `Hi ${store}, I have a question.`,
  /** Names the order by its display number only; that number grants nothing. */
  order: (store: string, orderNumber: string) =>
    `Hi ${store}, I have a question about my order ${orderNumber}.`,
  product: (store: string, product: { name: string; priceFromFils: number; soldOut: boolean }) =>
    product.soldOut
      ? `Hi ${store}, please let me know when ${product.name} is back in stock.`
      : `Hi ${store}, I have a question about ${product.name} (${displayAed(product.priceFromFils)}).`,
  /** The cart as a readable list: quantities, names, options. No totals: the store confirms those. */
  cart: (
    store: string,
    lines: ReadonlyArray<{ name: string; options: string; quantity: number }>,
  ) =>
    `Hi ${store}, I would like to order: ` +
    lines
      .slice(0, 20)
      .map((line) => `${line.quantity} x ${line.name}${line.options ? ` (${line.options})` : ""}`)
      .join("; ") +
    ".",
} as const;
