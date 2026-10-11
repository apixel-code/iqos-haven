import { STORE_PRODUCT_SORTS, type StoreProductCard, type StoreProductSort } from "@ih/contracts";

/**
 * Pure helpers for the listing pages (roadmap step 59). Everything that comes from the address
 * bar is reduced here to the few values the API contract accepts; anything else (tracking
 * parameters, unknown values, repeated values) is dropped, never forwarded.
 */
export const SORT_LABELS: Record<StoreProductSort, string> = {
  newest: "Newest",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  name: "Name: A to Z",
};
export const TYPE_PAGES = {
  disposable: {
    path: "/disposable-vapes",
    title: "Disposable Vapes",
    lead: "Pre-filled, ready to use. Sort by price or filter by brand.",
    filterLabel: "Disposable vapes",
  },
  kit: {
    path: "/vape-kits",
    title: "Vape Kits & Devices",
    lead: "Refillable pod systems.",
    filterLabel: "Vape kits & devices",
  },
} as const;
export type ProductType = keyof typeof TYPE_PAGES;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
type RawParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export interface ListingState {
  brand?: string;
  type?: ProductType;
  sort: StoreProductSort;
  cursor?: string;
}

/** Reads the listing controls from the address bar; invalid values fall back to defaults. */
export function parseListing(raw: RawParams): ListingState {
  const brand = single(raw.brand);
  const type = single(raw.type);
  const sort = single(raw.sort);
  const cursor = single(raw.cursor);
  return {
    ...(brand && brand.length <= 150 && SLUG.test(brand) ? { brand } : {}),
    ...(type === "disposable" || type === "kit" ? { type } : {}),
    sort: (STORE_PRODUCT_SORTS as readonly string[]).includes(sort ?? "")
      ? (sort as StoreProductSort)
      : "newest",
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
  };
}

/** A link to `path` with the given listing controls; defaults are left out of the URL. */
export function listingHref(path: string, state: Partial<ListingState>): string {
  const query = new URLSearchParams();
  if (state.type) query.set("type", state.type);
  if (state.brand) query.set("brand", state.brand);
  if (state.sort && state.sort !== "newest") query.set("sort", state.sort);
  if (state.cursor) query.set("cursor", state.cursor);
  return query.size ? `${path}?${query}` : path;
}

/**
 * Display price from integer fils: whole dirhams without decimals, otherwise two decimals.
 * Integer arithmetic only. The server quote, not this text, decides what is charged.
 */
export function displayAed(fils: number): string {
  // The contract only carries non-negative integers; anything else is a bug, not a price.
  if (!Number.isSafeInteger(fils) || fils < 0) throw new RangeError("Invalid fils amount");
  const whole = Math.trunc(fils / 100).toLocaleString("en-US");
  const cents = fils % 100;
  return cents === 0 ? `AED ${whole}` : `AED ${whole}.${String(cents).padStart(2, "0")}`;
}

/** Whole-percent saving for the sale badge, or null when there is nothing to show. */
export function discountPercent(priceFils: number, compareAtFils: number | null): number | null {
  if (compareAtFils === null || compareAtFils <= priceFils || compareAtFils <= 0) return null;
  const percent = Math.round(((compareAtFils - priceFils) * 100) / compareAtFils);
  return percent >= 1 ? percent : null;
}

/** The mono line under the product name. */
export function cardMeta(card: Pick<StoreProductCard, "type" | "puffCount" | "variantCount">) {
  const options = `${card.variantCount} ${card.variantCount === 1 ? "option" : "options"}`;
  if (card.type === "disposable" && card.puffCount) {
    const puffs =
      card.puffCount >= 1000 ? `${Math.round(card.puffCount / 1000)}K` : String(card.puffCount);
    return `${puffs} puffs · ${options}`;
  }
  return options;
}

export type CardBadge = { kind: "soldOut" | "sale" | "new"; label: string };
/** Sold out replaces the others; a sale and "New" may sit together (prototype order). */
export function cardBadges(
  card: Pick<StoreProductCard, "soldOut" | "isNew" | "priceFromFils" | "compareAtPriceFils">,
): CardBadge[] {
  if (card.soldOut) return [{ kind: "soldOut", label: "Sold out" }];
  const badges: CardBadge[] = [];
  const percent = discountPercent(card.priceFromFils, card.compareAtPriceFils);
  if (percent !== null) badges.push({ kind: "sale", label: `−${percent}%` });
  if (card.isNew) badges.push({ kind: "new", label: "New" });
  return badges;
}
