import type { Metadata } from "next";
import { arabicCategory, languageAlternates } from "@/lib/ar";
import Link from "next/link";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { Money } from "@/components/money";
import { servedEmirates } from "@/lib/emirates";
import { pageDescription, SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `IQOS & TEREA delivery across the UAE · ${SITE.name}`,
  description: pageDescription("Where we deliver IQOS ILUMA devices and TEREA sticks."),
  alternates: languageAlternates("/delivery", "en"),
};

/** Delivery by emirate (ADR 0118): the emirates the Owner serves, from the delivery settings. */
export default async function DeliveryPage() {
  const delivery = await storeRead((api, shopper) => api.delivery(shopper));
  const served = servedEmirates(delivery);
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Delivery" }]} />
      <PageHead
        title="Delivery across the UAE"
        lead="Choose your emirate to see the areas we deliver to. You pay cash on delivery."
      />
      <div className="prose">
        {delivery.feeFils !== null && (
          <p>
            Delivery is <Money fils={delivery.feeFils} /> per order, the same in every emirate
            {delivery.freeThresholdFils !== null && (
              <>
                , and free when your items total <Money fils={delivery.freeThresholdFils} /> or more
                after any discount
              </>
            )}
            .{delivery.etaText ? ` ${delivery.etaText}.` : ""}
          </p>
        )}
        {served.length === 0 ? (
          <p>Delivery areas are being set up. Message us on WhatsApp to ask about your area.</p>
        ) : (
          <ul>
            {served.map((place) => (
              <li key={place.slug}>
                <Link href={`/delivery/${place.slug}`} prefetch={false} className="underline">
                  Delivery in {place.name}
                </Link>{" "}
                <span className="muted">
                  ({place.areas.length} {place.areas.length === 1 ? "area" : "areas"})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
