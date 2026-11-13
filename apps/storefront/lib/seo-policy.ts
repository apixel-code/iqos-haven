import { publicSeoPolicySchema, type SeoPolicy } from "@ih/contracts";
import { storefrontEnv } from "./env";
import { POLICY_PAGES } from "./site";

/**
 * The Owner's indexing policy (roadmap step 113, ADRs 0079 and 0114), read from the API's public answer.
 * Closed unless the API says otherwise: a slow, failed or unexpected answer keeps the store
 * closed to crawlers. Held per server process for `SEO_POLICY_CACHE_SECONDS` (60 by default).
 * Server code only.
 */
const CLOSED: SeoPolicy = { indexing: "closed" };
let held: { policy: SeoPolicy; until: number } | undefined;

/** The public policy pages (no catalogue data): offered under `public_pages` and `catalogue`. */
export const INDEXABLE_PATHS: readonly string[] = POLICY_PAGES.map((page) => page.path);

export async function readSeoPolicy(now = Date.now()): Promise<SeoPolicy> {
  if (held && held.until > now) return held.policy;
  const env = storefrontEnv();
  let policy = CLOSED;
  try {
    const response = await fetch(new URL("/v1/public/seo", env.API_INTERNAL_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const parsed = publicSeoPolicySchema.safeParse(await response.json());
      if (parsed.success) policy = parsed.data;
    }
  } catch {
    policy = CLOSED;
  }
  held = { policy, until: now + env.SEO_POLICY_CACHE_SECONDS * 1000 };
  return policy;
}

/** Tests only. */
export function forgetSeoPolicy(): void {
  held = undefined;
}

/**
 * Catalogue pages offered to search engines under the `catalogue` policy (ADR 0114): the shop's
 * listing pages, brand, category and product pages, and a product's stable picture address.
 * Exact lower-case paths only. Cart, checkout, search, saved lists and order pages are never
 * offered.
 */
const CATALOGUE_PAGES: readonly string[] = [
  "/",
  "/shop",
  "/devices",
  "/sticks",
  "/brands",
  "/offers",
  "/help",
];
const CATALOGUE_PATH = /^\/(?:p|brands|categories)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_PICTURE_PATH = /^\/p\/[a-z0-9]+(?:-[a-z0-9]+)*\/image$/;
export const CATALOGUE_STATIC_PAGES = CATALOGUE_PAGES;
export const isCataloguePath = (pathname: string) =>
  pathname.length <= 200 &&
  (CATALOGUE_PAGES.includes(pathname) ||
    CATALOGUE_PATH.test(pathname) ||
    PRODUCT_PICTURE_PATH.test(pathname));

export const pageIsIndexable = (policy: SeoPolicy, pathname: string) =>
  policy.indexing === "public_pages"
    ? INDEXABLE_PATHS.includes(pathname)
    : policy.indexing === "catalogue" &&
      (INDEXABLE_PATHS.includes(pathname) || isCataloguePath(pathname));

/**
 * Whether a verified crawler may read this request without the age check: only reads of
 * catalogue pages, and only while the Owner offers the catalogue.
 */
export const crawlerMayRead = (policy: SeoPolicy, method: string, pathname: string) =>
  policy.indexing === "catalogue" &&
  (method === "GET" || method === "HEAD") &&
  isCataloguePath(pathname);

/** Request header the routing gate sets for pages a crawler may index; pages read it for their robots meta. */
export const INDEXABLE_HEADER = "x-ih-indexable";
