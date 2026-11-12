import type { StoreProductCard } from "@ih/contracts";

/**
 * Pure helpers for the listing pages (roadmap step 59). Their address-bar filters are read by
 * `parseSearch` (lib/store/search.ts) since the listings share the search filters (parity G-S2).
 */
export const TYPE_PAGES = {
  device: {
    path: "/devices",
    title: "IQOS Devices",
    lead: "IQOS ILUMA devices in every colour. Sort by price or filter by brand.",
    filterLabel: "IQOS devices",
  },
  sticks: {
    path: "/sticks",
    title: "TEREA Sticks",
    lead: "TEREA sticks for IQOS ILUMA, by version and flavour.",
    filterLabel: "TEREA sticks",
  },
  // Vape types stay readable for products stored before ADR 0101; they have no page of their own.
  disposable: {
    path: "/shop",
    title: "Shop",
    lead: "",
    filterLabel: "Disposable vapes",
  },
  kit: {
    path: "/shop",
    title: "Shop",
    lead: "",
    filterLabel: "Vape kits",
  },
} as const;
export type ProductType = keyof typeof TYPE_PAGES;
/** Types with their own listing page, header link and filter choice (ADR 0101). */
export const LISTED_TYPES = ["device", "sticks"] as const satisfies readonly ProductType[];
export type ListedType = (typeof LISTED_TYPES)[number];

/**
 * Display price from integer fils: whole dirhams without decimals, otherwise two decimals.
 * Integer arithmetic only. The server quote, not this text, decides what is charged.
 */
export function displayAed(fils: number): string {
  return `AED ${displayAmount(fils)}`;
}

/** The number part of a price ("49", "1,250.50"), shown after the dirham sign (ADR 0097). */
export function displayAmount(fils: number): string {
  // The contract only carries non-negative integers; anything else is a bug, not a price.
  if (!Number.isSafeInteger(fils) || fils < 0) throw new RangeError("Invalid fils amount");
  const whole = Math.trunc(fils / 100).toLocaleString("en-US");
  const cents = fils % 100;
  return cents === 0 ? whole : `${whole}.${String(cents).padStart(2, "0")}`;
}

/** Whole-percent saving for the sale badge, or null when there is nothing to show. */
export function discountPercent(priceFils: number, compareAtFils: number | null): number | null {
  if (compareAtFils === null || compareAtFils <= priceFils || compareAtFils <= 0) return null;
  const percent = Math.round(((compareAtFils - priceFils) * 100) / compareAtFils);
  return percent >= 1 ? percent : null;
}

/**
 * The mono line under the product name, or "" when there is nothing to say. A product with a
 * single option shows no count (Marina 2026-11-12: every product is now one flavour or colour).
 */
export function cardMeta(card: Pick<StoreProductCard, "type" | "puffCount" | "variantCount">) {
  const parts: string[] = [];
  if (card.type === "disposable" && card.puffCount)
    parts.push(
      `${card.puffCount >= 1000 ? `${Math.round(card.puffCount / 1000)}K` : String(card.puffCount)} puffs`,
    );
  if (card.variantCount > 1) parts.push(`${card.variantCount} options`);
  return parts.join(" · ");
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

/**
 * "More like this" on the product page (prototype): the brand's other products first, then
 * other brands of the same type; never the product itself or a sold-out one; at most four.
 */
export function relatedProducts<T extends { slug: string; soldOut: boolean }>(
  product: { slug: string },
  sameBrand: readonly T[],
  sameType: readonly T[],
  limit = 4,
): T[] {
  const seen = new Set([product.slug]);
  const picked: T[] = [];
  for (const item of [...sameBrand, ...sameType]) {
    if (picked.length === limit) break;
    if (item.soldOut || seen.has(item.slug)) continue;
    seen.add(item.slug);
    picked.push(item);
  }
  return picked;
}
