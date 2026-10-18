import type { StoreProductCard } from "@ih/contracts";

/**
 * Pure helpers for the listing pages (roadmap step 59). Their address-bar filters are read by
 * `parseSearch` (lib/store/search.ts) since the listings share the search filters (parity G-S2).
 */
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
