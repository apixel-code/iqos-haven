import type { MetadataRoute } from "next";
import { ageGate } from "@/lib/age/runtime";
import { INDEXABLE_PATHS, readSeoPolicy } from "@/lib/seo-policy";

/**
 * Crawler policy (architecture §9, ADR 0026, step 113 ADR 0079). Closed (the default while the
 * Owner has not chosen otherwise): everything disallowed, no sitemap. With public pages: only
 * the policy pages are allowed and the sitemap lists them. Products are never offered here.
 */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const policy = await readSeoPolicy();
  if (policy.indexing !== "public_pages") return { rules: [{ userAgent: "*", disallow: "/" }] };
  const origin = ageGate().runtime.origins[0]!;
  return {
    rules: [{ userAgent: "*", allow: [...INDEXABLE_PATHS], disallow: "/" }],
    sitemap: new URL("/sitemap.xml", origin).toString(),
  };
}
