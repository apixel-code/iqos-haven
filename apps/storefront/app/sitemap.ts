import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { isIP } from "node:net";
import { AGE_COOKIE, signAgeTicket } from "@ih/platform/age-ticket";
import { ageGate } from "@/lib/age/runtime";
import { storefrontEnv } from "@/lib/env";
import { CATALOGUE_STATIC_PAGES, INDEXABLE_PATHS, readSeoPolicy } from "@/lib/seo-policy";
import { createStoreApi, type ShopperContext } from "@/lib/store/api";

/**
 * Public sitemap (architecture §9, ADRs 0079 and 0114). Closed: an empty list. Public pages:
 * the policy pages. Whole catalogue: also the shop pages, every brand and category with
 * products, every published product and every published guide (ADR 0117). The catalogue is read from the API with a ticket
 * minted for this one request; the requester's address is passed on, so the API's per-address
 * read limit applies to whoever asks for the sitemap.
 */
export const dynamic = "force-dynamic";

/** 48 products a page: room for 4,800 products before the list is cut short. */
const MAX_PRODUCT_PAGES = 100;

/** A page of the sitemap; a product page names its stable picture address (`/p/<slug>/image`). */
interface Entry {
  path: string;
  image?: boolean;
}

async function catalogueEntries(): Promise<Array<string | Entry>> {
  const { runtime } = ageGate();
  if (!runtime.signer) throw new Error("sitemap: no age-ticket signing key");
  const { ticket } = signAgeTicket(runtime.signer, {
    policyVersion: runtime.policyVersion,
    ttlSeconds: 60,
  });
  const ip = (await headers()).get("x-ih-client-ip");
  const shopper: ShopperContext = {
    cookieHeader: `${AGE_COOKIE}=${ticket}`,
    clientIp: ip && isIP(ip) ? ip : null,
  };
  const api = createStoreApi({ baseUrl: storefrontEnv().API_INTERNAL_URL });
  const [brands, categories, guides] = await Promise.all([
    api.brands(shopper),
    api.categories(shopper),
    api.guides(shopper),
  ]);
  const paths: Array<string | Entry> = [
    ...CATALOGUE_STATIC_PAGES,
    ...guides.items.map((guide) => `/guides/${guide.slug}`),
    ...brands.items.filter((b) => b.productCount > 0).map((b) => `/brands/${b.slug}`),
    ...categories.items.filter((c) => c.productCount > 0).map((c) => `/categories/${c.slug}`),
  ];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PRODUCT_PAGES; page++) {
    const { items, nextCursor } = await api.products(shopper, {
      sort: "name",
      limit: 48,
      ...(cursor ? { cursor } : {}),
    });
    // The picture address redirects to a fresh signed link: storage links expire in minutes.
    paths.push(
      ...items.map((product) => ({ path: `/p/${product.slug}`, image: product.image !== null })),
    );
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return paths;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const policy = await readSeoPolicy();
  if (policy.indexing === "closed") return [];
  const origin = ageGate().runtime.origins[0]!;
  // A failed catalogue read fails the whole sitemap (a 500 is retried); a partial list is never served.
  const entries: Array<string | Entry> = [
    ...(policy.indexing === "catalogue" ? await catalogueEntries() : []),
    ...INDEXABLE_PATHS,
  ];
  return entries.map((entry) => {
    const { path, image } = typeof entry === "string" ? { path: entry, image: false } : entry;
    const url = new URL(path, origin).toString();
    return image ? { url, images: [`${url}/image`] } : { url };
  });
}
