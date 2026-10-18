import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import type { StoreProductResponse } from "@ih/contracts";
import { BuyBox } from "@/components/buy-box";
import { ProductReviews, RatingLink } from "@/components/product-reviews";
import { CompareToggle } from "@/components/compare-toggle";
import { RecentlyViewed, RecordView } from "@/components/recently-viewed";
import { SaveButton } from "@/components/save-button";
import { Gallery } from "@/components/gallery";
import { SectionHead } from "@/components/home-sections";
import { Icon } from "@/components/icons";
import { Breadcrumbs } from "@/components/listing";
import { ProductRail } from "@/components/product-card";
import { SITE } from "@/lib/site";
import { relatedProducts, TYPE_PAGES } from "@/lib/store/listing";
import { offeredOptions } from "@/lib/store/selection";
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
  /** The values offered for an option (the prototype's nicotine and flavour rows). */
  const option = (name: string) => offeredOptions(product).find((o) => o.name === name)?.values;
  const rows: Array<[string, string | number | null | false]> =
    product.type === "disposable"
      ? [
          ["Puffs (approx.)", product.puffCount ? product.puffCount.toLocaleString("en-US") : null],
          ["Nicotine", option("nicotine")?.join(" / ") ?? null],
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
          ["Flavours", option("flavour") ? String(option("flavour")!.length) : null],
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
  const optional = <T,>(read: Promise<{ items: T[] }>) =>
    read.catch((error: unknown) => {
      if (error instanceof StoreApiError) return { items: [] as T[] };
      throw error;
    });
  const [sameBrand, sameType] = await Promise.all([
    optional(
      storeRead((api, shopper) => api.products(shopper, { brand: product.brand.slug, limit: 9 })),
    ),
    optional(storeRead((api, shopper) => api.products(shopper, { type: product.type, limit: 9 }))),
  ]);
  const more = relatedProducts(product, sameBrand.items, sameType.items);
  const specs = specRows(product);
  const whatsappMessage = WHATSAPP_MESSAGES.product(SITE.name, {
    name: product.name,
    priceFromFils: Math.min(...product.variants.map((variant) => variant.priceFils)),
    soldOut: product.soldOut,
  });
  const whatsapp = whatsappHref(whatsappNumber, whatsappMessage);
  return (
    <>
      <Breadcrumbs
        trail={[
          { label: "Home", href: "/" },
          { label: typePage.title, href: typePage.path },
          { label: product.name },
        ]}
      />
      <div className="pdp">
        <Gallery images={product.images} name={product.name} />
        <div className="buy" id="buybox">
          <div className="buy-top">
            <a href={`/brands/${product.brand.slug}`} className="brandlink">
              {product.brand.name}
            </a>
            <h1 className="h1">{product.name}</h1>
            <RatingLink rating={product.rating} />
          </div>
          {/* Keyed by product so choices never carry over to another product. */}
          <BuyBox
            key={product.slug}
            product={product}
            whatsappHref={whatsapp}
            save={<SaveButton slug={product.slug} name={product.name} variant="page" />}
          />
          {whatsapp && (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="wa-link">
              <Icon name="wa" />
              {product.soldOut
                ? "Ask on WhatsApp when it's back"
                : "Ask about this product on WhatsApp"}
            </a>
          )}
          {product.type === "kit" && <CompareToggle slug={product.slug} />}
          <div className="assure">
            <div>
              <Icon name="truck" />
              <p>
                <b>Delivery across the UAE</b>
                <span>All seven emirates, one flat delivery fee shown at checkout.</span>
              </p>
            </div>
            <div>
              <Icon name="cash" />
              <p>
                <b>Cash on delivery</b>
                <span>Pay the courier when your order arrives.</span>
              </p>
            </div>
            <div>
              <Icon name="shield" />
              <p>
                <b>Genuine brand stock</b>
                <span>Sourced from authorised UAE distributors.</span>
              </p>
            </div>
          </div>
          <div className="warn">
            <Icon name="info" />
            <p>This product contains nicotine, which is an addictive substance.</p>
          </div>
        </div>
      </div>
      {(product.description || specs.length > 0) && (
        <div className="pdp-more">
          {product.description && (
            <section aria-labelledby="desc-h">
              <h2 className="h3 pdp-h" id="desc-h">
                About this product
              </h2>
              <div className="desc">
                {product.description.split(/\n\s*\n/).map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
            </section>
          )}
          {specs.length > 0 && (
            <section aria-labelledby="spec-h">
              <h2 className="h3 pdp-h spec" id="spec-h">
                Specifications
              </h2>
              <table className="specs">
                <tbody>
                  {specs.map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
      <ProductReviews rating={product.rating} reviews={product.reviews} />
      <RecordView slug={product.slug} />
      {more.length > 0 && (
        <section className="sec" aria-labelledby="rel-h">
          <SectionHead
            id="rel-h"
            title="More like this"
            sub={`More from ${product.brand.name} and similar ${product.type === "kit" ? "kits" : "disposables"}`}
          />
          <ProductRail products={more} />
        </section>
      )}
      <RecentlyViewed exclude={product.slug} />
    </>
  );
}
