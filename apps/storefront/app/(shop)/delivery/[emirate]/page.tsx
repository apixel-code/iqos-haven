import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { Breadcrumbs } from "@/components/listing";
import { Money } from "@/components/money";
import { ageGate } from "@/lib/age/runtime";
import { emirateOfSlug, servedEmirates } from "@/lib/emirates";
import { breadcrumbJsonLd } from "@/lib/seo-data";
import { readSeoPolicy } from "@/lib/seo-policy";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

type Props = { params: Promise<{ emirate: string }> };

/** The emirate and its active areas, or null when the Owner serves none there. */
async function placeOf(slug: string) {
  const emirate = emirateOfSlug(slug);
  if (!emirate) return null;
  const delivery = await storeRead((api, shopper) => api.delivery(shopper));
  const place = servedEmirates(delivery).find((item) => item.emirate === emirate);
  return place ? { place, delivery } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await placeOf((await params).emirate);
  if (!found) return { title: SITE.name };
  const { place } = found;
  return {
    title: `IQOS ILUMA & TEREA delivery in ${place.name} · ${SITE.name}`,
    description: `Order IQOS ILUMA devices and TEREA sticks with delivery in ${place.name}, cash on delivery. ${place.areas.length} ${place.areas.length === 1 ? "area" : "areas"} served. Adults only, 18+.`,
    alternates: { canonical: `/delivery/${place.slug}` },
  };
}

/**
 * Delivery in one emirate (ADR 0118). The fee, time and areas are the Owner's settings; the
 * rest points shoppers to the shop, the guides and the help page.
 */
export default async function EmirateDeliveryPage({ params }: Props) {
  const found = await placeOf((await params).emirate);
  if (!found) notFound();
  const { place, delivery } = found;
  const trail = [
    { label: "Home", href: "/" },
    { label: "Delivery", href: "/delivery" },
    { label: place.name },
  ];
  const offered = (await readSeoPolicy()).indexing === "catalogue";
  return (
    <>
      {offered && <JsonLd data={breadcrumbJsonLd(trail, ageGate().runtime.origins[0]!)} />}
      <Breadcrumbs trail={trail} />
      <header className="shop-head">
        <h1 className="h1">IQOS ILUMA and TEREA delivery in {place.name}</h1>
        <p className="muted">
          Order online and pay cash on delivery. For adults aged 18 or over only.
        </p>
      </header>
      <div className="prose">
        <h2 className="h2">Fee and delivery time</h2>
        {delivery.feeFils !== null ? (
          <p>
            Delivery to {place.name} is <Money fils={delivery.feeFils} /> per order
            {delivery.freeThresholdFils !== null && (
              <>
                , free when your items total <Money fils={delivery.freeThresholdFils} /> or more
                after any discount
              </>
            )}
            .{delivery.etaText ? ` ${delivery.etaText}.` : ""} You see the fee and the total before
            you order.
          </p>
        ) : (
          <p>You see the delivery fee and the total before you order.</p>
        )}
        <h2 className="h2">Areas we deliver to in {place.name}</h2>
        <ul className="sm:columns-2">
          {place.areas.map((area) => (
            <li key={area}>{area}</li>
          ))}
        </ul>
        <p>
          Choose your area at checkout. Your area is not listed? Message us on WhatsApp from the{" "}
          <Link href="/help#help-contact" prefetch={false} className="underline">
            help page
          </Link>{" "}
          and we will tell you whether we can deliver.
        </p>
        <h2 className="h2">What you can order</h2>
        <ul>
          <li>
            <Link href="/devices" prefetch={false} className="underline">
              IQOS ILUMA devices
            </Link>
            : every model and colour. Not sure which? Read{" "}
            <Link href="/guides/iqos-iluma-models-compared" prefetch={false} className="underline">
              IQOS ILUMA models compared
            </Link>
            .
          </li>
          <li>
            <Link href="/sticks" prefetch={false} className="underline">
              TEREA sticks
            </Link>
            : seven editions, sold by the carton. See{" "}
            <Link href="/guides/terea-editions-explained" prefetch={false} className="underline">
              TEREA editions explained
            </Link>
            .
          </li>
        </ul>
        <h2 className="h2">Paying</h2>
        <p>
          Pay the courier in cash when your order arrives, or choose bank transfer or online payment
          at checkout and we send the details on WhatsApp. See{" "}
          <Link href="/help#help-delivery" prefetch={false} className="underline">
            delivery information
          </Link>{" "}
          for more.
        </p>
      </div>
    </>
  );
}
