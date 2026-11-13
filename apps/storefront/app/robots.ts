import type { MetadataRoute } from "next";
import { ageGate } from "@/lib/age/runtime";
import { INDEXABLE_PATHS, readSeoPolicy } from "@/lib/seo-policy";

/**
 * Crawler policy (architecture §9, ADRs 0026, 0079 and 0114). Closed (the default while the
 * Owner has not chosen otherwise): everything disallowed, no sitemap. Public pages: only the
 * policy pages. Whole catalogue: the store is allowed except the pages that hold a shopper's
 * own state (cart, checkout, search, saved lists, orders) and the gate itself.
 */
export const dynamic = "force-dynamic";

const PRIVATE_PAGES = [
  "/cart",
  "/checkout",
  "/search",
  "/wishlist",
  "/compare",
  "/track",
  "/order-confirmation",
  "/review",
  "/age-check",
  "/restricted",
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const policy = await readSeoPolicy();
  if (policy.indexing === "closed") return { rules: [{ userAgent: "*", disallow: "/" }] };
  const sitemap = new URL("/sitemap.xml", ageGate().runtime.origins[0]!).toString();
  if (policy.indexing === "catalogue")
    return { rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE_PAGES }], sitemap };
  return { rules: [{ userAgent: "*", allow: [...INDEXABLE_PATHS], disallow: "/" }], sitemap };
}
