import type { MetadataRoute } from "next";
import { ageGate } from "@/lib/age/runtime";
import { INDEXABLE_PATHS, readSeoPolicy } from "@/lib/seo-policy";

/**
 * Public sitemap (architecture §9, step 113 ADR 0079): the policy pages only, and only while the
 * Owner offers public pages. Closed: an empty list. No product, brand or category URL is ever
 * listed while product indexing is inactive (BI-05).
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const policy = await readSeoPolicy();
  if (policy.indexing !== "public_pages") return [];
  const origin = ageGate().runtime.origins[0]!;
  return INDEXABLE_PATHS.map((path) => ({ url: new URL(path, origin).toString() }));
}
