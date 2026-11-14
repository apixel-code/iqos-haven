import type { Metadata } from "next";
import Link from "next/link";
import { STORE_PAGE_SIZES } from "@ih/contracts";
import { ProductSection } from "@/components/home-sections";
import { Breadcrumbs } from "@/components/listing";
import { AR, arabicCategory, languageAlternates } from "@/lib/ar";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `${AR.homeTitle} · ${SITE.name}`,
  description: AR.homeLead,
  alternates: languageAlternates("/ar", "ar"),
};

/** The Arabic home (ADR 0120): what the store sells, its editions and models, and delivery. */
export default async function ArabicHomePage() {
  const [categories, sticks, devices] = await storeRead((api, shopper) =>
    Promise.all([
      api.categories(shopper),
      api.products(shopper, { type: "sticks", sort: "name", limit: STORE_PAGE_SIZES.max }),
      api.products(shopper, { type: "device", sort: "price_asc", limit: 8 }),
    ]),
  );
  const named = categories.items
    .filter((category) => category.productCount > 0)
    .map((category) => ({ category, ar: arabicCategory(category) }))
    .filter((item) => item.ar !== null);
  const editions = named.filter((item) => item.category.slug.startsWith("terea"));
  const models = named.filter((item) => item.category.slug.startsWith("iqos"));
  const links = (items: typeof named) => (
    <ul className="flex flex-wrap gap-2">
      {items.map(({ category, ar }) => (
        <li key={category.slug}>
          <Link href={`/ar/categories/${category.slug}`} prefetch={false} className="chip">
            {ar!.title}
          </Link>
        </li>
      ))}
    </ul>
  );
  return (
    <div lang="ar" dir="rtl">
      <Breadcrumbs trail={[{ label: AR.home }]} />
      <header className="shop-head">
        <h1 className="h1">{AR.homeTitle}</h1>
        <p className="muted">{AR.homeLead}</p>
        <p className="text-sm">
          <Link href="/" prefetch={false} lang="en" dir="ltr" className="underline">
            {AR.english}
          </Link>
        </p>
      </header>
      <section className="sec" aria-labelledby="ar-editions-h">
        <h2 className="h2" id="ar-editions-h">
          {AR.editions}
        </h2>
        {links(editions)}
      </section>
      <section className="sec" aria-labelledby="ar-models-h">
        <h2 className="h2" id="ar-models-h">
          {AR.models}
        </h2>
        {links(models)}
      </section>
      <ProductSection
        id="ar-sticks-h"
        title={AR.sticks}
        sub={AR.sticksLead}
        products={sticks.items}
        more={{ label: AR.shopAll, href: "/ar/sticks" }}
      />
      <ProductSection
        id="ar-devices-h"
        title={AR.devices}
        sub={AR.devicesLead}
        products={devices.items}
        more={{ label: AR.shopAll, href: "/ar/devices" }}
      />
      <section className="sec" aria-labelledby="ar-delivery-h">
        <h2 className="h2" id="ar-delivery-h">
          {AR.delivery}
        </h2>
        <p className="muted">
          {AR.deliveryLead}{" "}
          <Link href="/ar/delivery" prefetch={false} className="underline">
            {AR.delivery}
          </Link>
        </p>
        <p className="muted">{AR.adults}</p>
      </section>
    </div>
  );
}
