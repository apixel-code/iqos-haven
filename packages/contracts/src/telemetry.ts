import { z } from "zod";

/**
 * Anonymous browsing events (roadmap step 103, ADR 0069). `POST /v1/store/events` takes a small
 * batch from the storefront. Each event is one of six fixed shapes with no free text except a
 * search term, which the API normalizes and redacts when it looks personal. Nothing here
 * identifies a customer: no name, phone, address, email, order or IP.
 */
export const BROWSING_EVENT_TYPES = [
  "search",
  "product_view",
  "cart_add",
  "cart_remove",
  "wishlist_add",
  "wishlist_remove",
] as const;
export type BrowsingEventType = (typeof BROWSING_EVENT_TYPES)[number];
export const MAX_EVENTS_PER_BATCH = 20;
/** Bytes a whole batch may take; the route refuses larger bodies before parsing. */
export const MAX_EVENT_BATCH_BYTES = 8 * 1024;

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(150);
const base = { id: z.uuid() };
export const browsingEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("search"),
    /** As typed; normalized (and redacted if it looks like a phone or email) by the API. */
    term: z.string().min(1).max(100),
    resultCount: z.number().int().min(0).max(100_000),
  }),
  z.strictObject({ ...base, type: z.literal("product_view"), productSlug: slug }),
  z.strictObject({
    ...base,
    type: z.literal("cart_add"),
    variantId: z.uuid(),
    quantity: z.number().int().min(1).max(99),
  }),
  z.strictObject({
    ...base,
    type: z.literal("cart_remove"),
    variantId: z.uuid(),
    quantity: z.number().int().min(1).max(99),
  }),
  z.strictObject({ ...base, type: z.literal("wishlist_add"), productSlug: slug }),
  z.strictObject({ ...base, type: z.literal("wishlist_remove"), productSlug: slug }),
]);
export type BrowsingEvent = z.infer<typeof browsingEventSchema>;

export const storeEventsRequestSchema = z.strictObject({
  /** A random ID the browser rotates (step 104); optional. */
  anonymousId: z.uuid().optional(),
  events: z.array(browsingEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type StoreEventsRequest = z.infer<typeof storeEventsRequestSchema>;
/**
 * Always 202: telemetry is best effort. `stored` new events; `duplicate` already stored (a
 * resend); `dropped` events for products or variants a shopper cannot see, or a whole batch
 * shed under load.
 */
export const storeEventsResponseSchema = z.strictObject({
  stored: z.number().int().min(0),
  duplicate: z.number().int().min(0),
  dropped: z.number().int().min(0),
});
export type StoreEventsResponse = z.infer<typeof storeEventsResponseSchema>;

/** At most this many digits in a search term before it is treated as a phone number. */
const MAX_TERM_DIGITS = 5;
/** A product search is short; a longer phrase is more likely to be a name or an address. */
const MAX_TERM_LENGTH = 40;
const MAX_TERM_WORDS = 4;
/**
 * A search term as counted: NFKC (so Arabic-Indic digits count as digits), lower case, single
 * spaces, no controls or hidden marks. Only the fact of a search is kept (`null`) when the term
 * has an "@", more than five digits of any script, more than four words or more than 40
 * characters: it may be a phone number, an email, a name or an address.
 */
export function normalizeSearchTerm(raw: string): string | null {
  const term = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  if (term.includes("@") || (term.match(/\p{Nd}/gu)?.length ?? 0) > MAX_TERM_DIGITS) return null;
  if (term.split(" ").length > MAX_TERM_WORDS) return null;
  return term;
}
