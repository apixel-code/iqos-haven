import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import type { StoreProductResponse } from "@ih/contracts";
import { BuyBox } from "@/components/buy-box";
import { ProductReviews, RatingLink } from "@/components/product-reviews";
import { CompareToggle } from "@/components/compare-toggle";
import { RecentlyViewed, RecordView } from "@/components/recently-viewed";
import { SaveButton } from "@/components/save-button";
import { WhatsAppLink } from "@/components/whatsapp-link";
import { Gallery } from "@/components/gallery";
import { Breadcrumbs } from "@/components/listing";
import { ProductGrid } from "@/components/product-card";
import { SITE } from "@/lib/site";
import { TYPE_PAGES } from "@/lib/store/listing";
import { StoreApiError } from "@/lib/store/api";
import { storeInfo, storeRead } from "@/lib/store/server";
import { WHATSAPP_MESSAGES, whatsappHref } from "@/lib/whatsapp";

type Props = { params: Promise<{ slug: string }> };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function productOf(slug: string) {
  // A slug that cannot exist is not worth an API call.
  if (slug.length > 150 || !SLUG.test(slug)) return null;
  return storeRead((api, shopper) => api.product(shopper, slug));
}

// Runs only for requests the routing gate let through (ADR 0026): the product name may appear
// in the title of a verified shopper's page. Link previews stay generic.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await productOf((await params).slug);
  if (!product) return { title: SITE.name };
  return {
    title: `${product.seo.title ?? product.name} · ${SITE.name}`,
    ...(product.seo.description ? { description: product.seo.description } : {}),
    // The current slug, also when reached through a former one (step 101).
    alternates: { canonical: `/p/${product.slug}` },
  };
}

/** Specification rows with the prototype's labels; only rows that have a value are shown. */
function specRows(product: StoreProductResponse): Array<[string, string]> {
  const specs = product.specs as Record<string, unknown>;
  const text = (key: string) => (typeof specs[key] === "string" ? (specs[key] as string) : null);
  const number = (key: string) => (typeof specs[key] === "number" ? (specs[key] as number) : null);
  const rows: Array<[string, string | number | null | false]> =
    product.type === "disposable"
      ? [
          ["Puffs (approx.)", product.puffCount ? product.puffCount.toLocaleString("en-US") : null],
          ["E-liquid", text("liquidMl") && `${text("liquidMl")} ml`],
          ["Battery", number("batteryMah") && `${number("batteryMah")} mAh`],
          [
            "Charging",
            text("charging") ??
              (specs.rechargeable === true
                ? "Rechargeable"
                : specs.rechargeable === false
                  ? "Not rechargeable"
                  : null),
          ],
        ]
      : [
          ["Battery", number("batteryMah") && `${number("batteryMah")} mAh`],
          ["Output", number("maxOutputW") && `Up to ${number("maxOutputW")}W`],
          ["Pod capacity", text("podCapacityMl") && `${text("podCapacityMl")} ml`],
          ["Coil resistance", text("coilOhm") && `${text("coilOhm")} Ω`],
          ["Charging", text("charging")],
          ["Display", text("display")],
          ["In the box", text("inTheBox")],
        ];
  const extra = Array.isArray(specs.extra)
    ? (specs.extra as Array<{ label: string; value: string }>).map((row): [string, string] => [
        row.label,
        row.value,
      ])
    : [];
  return [
    ...rows.filter((row): row is [string, string] => typeof row[1] === "string" && row[1] !== ""),
    ...extra,
  ];
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await productOf(slug);
  if (!product) notFound();
  // The product was renamed: send the shopper (and old links) to its current address.
  if (product.slug !== slug) permanentRedirect(`/p/${product.slug}`);
  const typePage = TYPE_PAGES[product.type];
  const { whatsappNumber } = await storeInfo();
  // Optional section: if it cannot be loaded the product page still renders.
  const related = await storeRead((api, shopper) =>
    api.products(shopper, { brand: product.brand.slug, limit: 5 }),
  ).catch((error: unknown) => {
    if (error instanceof StoreApiError) return { items: [] };
    throw error;
  });
  const more = related.items.filter((item) => item.slug !== product.slug).slice(0, 4);
  const specs = specRows(product);
  return (
    <>
      <Breadcrumbs
        trail={[
          { label: "Home", href: "/" },
          { label: typePage.title, href: typePage.path },
          { label: product.name },
        ]}
      />
      <div className="grid gap-6 pt-4 md:grid-cols-[1.08fr_1fr] md:gap-12">
        <Gallery images={product.images} name={product.name} />
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <a
              href={`/brands/${product.brand.slug}`}
              className="text-xs font-medium uppercase tracking-[0.1em] text-ink-2 hover:text-ink"
            >
              {product.brand.name}
            </a>
            <h1 className="text-3xl font-semibold tracking-tight">{product.name}</h1>
            <RatingLink rating={product.rating} />
          </div>
          {/* Keyed by product so choices never carry over to another product. */}
          <BuyBox
            key={product.slug}
            product={product}
            whatsappHref={whatsappHref(
              whatsappNumber,
              WHATSAPP_MESSAGES.product(SITE.name, {
                name: product.name,
                priceFromFils: Math.min(...product.variants.map((variant) => variant.priceFils)),
                soldOut: product.soldOut,
              }),
            )}
          />
          <SaveButton slug={product.slug} name={product.name} variant="page" />
          {product.type === "kit" && <CompareToggle slug={product.slug} />}
          <WhatsAppLink
            number={whatsappNumber}
            message={WHATSAPP_MESSAGES.product(SITE.name, {
              name: product.name,
              priceFromFils: Math.min(...product.variants.map((variant) => variant.priceFils)),
              soldOut: product.soldOut,
            })}
          >
            {product.soldOut
              ? "Ask on WhatsApp when it's back"
              : "Ask about this product on WhatsApp"}
          </WhatsAppLink>
          <ul className="flex flex-col gap-1 text-sm text-ink-2">
            <li>
              <b className="font-medium text-ink">Cash on delivery.</b> Pay the courier when your
              order arrives.
            </li>
          </ul>
          <p className="rounded-md bg-warning-soft px-4 py-3 text-sm">
            This product contains nicotine, which is an addictive substance.
          </p>
        </div>
      </div>
      <div className="grid gap-8 pt-12 lg:grid-cols-2">
        {product.description && (
          <section aria-labelledby="about" className="flex flex-col gap-3">
            <h2 id="about" className="text-xl font-semibold tracking-tight">
              About this product
            </h2>
            <p className="whitespace-pre-line text-sm text-ink-2">{product.description}</p>
          </section>
        )}
        {specs.length > 0 && (
          <section aria-labelledby="specs" className="flex flex-col gap-3">
            <h2 id="specs" className="text-xl font-semibold tracking-tight">
              Specifications
            </h2>
            <dl className="divide-y divide-line text-sm">
              {specs.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-2.5">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
      <ProductReviews rating={product.rating} reviews={product.reviews} />
      <RecordView slug={product.slug} />
      {more.length > 0 && (
        <section aria-labelledby="more" className="flex flex-col gap-5 pt-12">
          <h2 id="more" className="text-xl font-semibold tracking-tight">
            More from {product.brand.name}
          </h2>
          <ProductGrid products={more} />
        </section>
      )}
      <RecentlyViewed exclude={product.slug} />
    </>
  );
}
