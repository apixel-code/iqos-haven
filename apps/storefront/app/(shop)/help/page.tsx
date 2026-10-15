import type { Metadata } from "next";
import Link from "next/link";
import { EMIRATE_NAMES } from "@ih/contracts";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { WhatsAppLink } from "@/components/whatsapp-link";
import { POLICY_PAGES, SITE } from "@/lib/site";
import { displayAed } from "@/lib/store/listing";
import { storeInfo, storeRead } from "@/lib/store/server";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";

export const metadata: Metadata = { title: `Help · ${SITE.name}` };

const h2 = "text-xl font-semibold tracking-tight";
const card = "flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 sm:p-6";

/**
 * Help (roadmap step 100; prototype `help`). Delivery facts come from the Owner's settings
 * through the API, never from copy: the fee, the time and the emirates actually served. Free
 * delivery is mentioned only while a threshold is switched on, which it is not at launch.
 * Wording without approved client copy (returns, hours) says so plainly (BI-01, BI-09).
 */
export default async function HelpPage() {
  const [delivery, { whatsappNumber }] = await Promise.all([
    storeRead((api, shopper) => api.delivery(shopper)),
    storeInfo(),
  ]);
  const emirates = [...new Set(delivery.areas.map((area) => area.emirate))].map(
    (emirate) => (EMIRATE_NAMES as Readonly<Record<string, string>>)[emirate] ?? emirate,
  );
  const faq = [
    {
      q: "How does cash on delivery work?",
      a: "Place your order without paying online. The courier collects the total in cash when your order arrives. Have the exact amount ready if you can.",
    },
    {
      q: "Where do you deliver?",
      a: emirates.length
        ? `We deliver to areas in ${emirates.join(", ")}. Choose your area at checkout to see the fee and total before you order.`
        : "Delivery areas are being set up. Message us on WhatsApp and we will tell you whether we can deliver to you.",
    },
    {
      q: "Can I order on WhatsApp instead?",
      a: "Yes. Message us and we will help you choose a product and place the order with you.",
    },
    {
      q: "Can I return a product?",
      a: "Our return and exchange policy will be published here. Until then, message us on WhatsApp about any problem with your order.",
    },
  ];
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Help" }]} />
      <PageHead title="Help & policies" lead="Delivery, payment, and how to reach us." />
      <div className="grid gap-5 pt-2 lg:grid-cols-2">
        <section aria-labelledby="help-delivery" className={card}>
          <h2 id="help-delivery" className={h2}>
            Delivery
          </h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div>
              <dt className="font-medium">Fee</dt>
              <dd className="text-ink-2">
                {delivery.feeFils === null
                  ? "Shown with your total before you order."
                  : delivery.feeFils === 0
                    ? "Included in your total"
                    : `${displayAed(delivery.feeFils)} per order`}
              </dd>
            </div>
            {delivery.etaText && (
              <div>
                <dt className="font-medium">When it arrives</dt>
                <dd className="text-ink-2">{delivery.etaText}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium">Payment</dt>
              <dd className="text-ink-2">
                Cash on delivery. Pay the courier when your order arrives.
              </dd>
            </div>
            {emirates.length > 0 && (
              <div>
                <dt className="font-medium">Where</dt>
                <dd className="text-ink-2">{emirates.join(", ")}</dd>
              </div>
            )}
          </dl>
        </section>
        <section aria-labelledby="help-contact" className={card}>
          <h2 id="help-contact" className={h2}>
            Contact
          </h2>
          <p className="text-sm text-ink-2">
            {whatsappNumber
              ? "The fastest way to reach us is WhatsApp."
              : "Contact details will be published here shortly."}
          </p>
          <WhatsAppLink number={whatsappNumber} message={WHATSAPP_MESSAGES.general(SITE.name)}>
            Chat on WhatsApp
          </WhatsAppLink>
        </section>
        <section aria-labelledby="help-faq" className={`${card} lg:col-span-2`}>
          <h2 id="help-faq" className={h2}>
            Frequently asked questions
          </h2>
          <div className="flex flex-col divide-y divide-line">
            {faq.map((item) => (
              <details key={item.q} className="group py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <span aria-hidden="true" className="text-lg text-ink-3 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="pt-2 text-sm text-ink-2">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
        <section aria-labelledby="help-policies" className={`${card} lg:col-span-2`}>
          <h2 id="help-policies" className={h2}>
            Policies
          </h2>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {POLICY_PAGES.map((page) => (
              <li key={page.path}>
                <Link href={page.path} prefetch={false} className="underline underline-offset-2">
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
