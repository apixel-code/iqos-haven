import { storeRead } from "@/lib/store/server";

/**
 * A product's main picture at a stable address (ADR 0114). The storage links on a product page
 * are signed and expire within minutes, so a search engine cannot keep them; structured data
 * names this address instead, which answers with a redirect to a fresh link. It passes the
 * routing gate like the product page itself: a valid age ticket, or a verified crawler.
 */
export const dynamic = "force-dynamic";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product =
    slug.length <= 150 && SLUG.test(slug)
      ? await storeRead((api, shopper) => api.product(shopper, slug))
      : null;
  const picture = product?.images[0];
  if (!picture) return new Response(null, { status: 404 });
  return new Response(null, { status: 302, headers: { Location: picture.urls.large } });
}
