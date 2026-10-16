import { publicSeoPolicySchema, type SeoPolicy } from "@ih/contracts";
import { storefrontEnv } from "./env";
import { POLICY_PAGES } from "./site";

/**
 * The Owner's indexing policy (roadmap step 113, ADR 0079), read from the API's public answer.
 * Closed unless the API says otherwise: a slow, failed or unexpected answer keeps the store
 * closed to crawlers. Held per server process for `SEO_POLICY_CACHE_SECONDS` (60 by default).
 * Server code only.
 */
const CLOSED: SeoPolicy = { indexing: "closed" };
let held: { policy: SeoPolicy; until: number } | undefined;

/** The only pages a crawler may ever be offered: the public policy pages (no catalogue data). */
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

export const pageIsIndexable = (policy: SeoPolicy, pathname: string) =>
  policy.indexing === "public_pages" && INDEXABLE_PATHS.includes(pathname);
