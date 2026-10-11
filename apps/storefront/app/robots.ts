import type { MetadataRoute } from "next";

/**
 * Closed catalogue (architecture §9): nothing is offered to crawlers until the client approves
 * an indexing policy (BI-05). The `X-Robots-Tag: noindex` header says the same on every response.
 * No sitemap is published while indexing is off (step 113).
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
