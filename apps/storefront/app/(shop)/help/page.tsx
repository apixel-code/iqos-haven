import type { Metadata } from "next";
import Link from "next/link";
import { EMIRATE_NAMES } from "@ih/contracts";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icons";
import { WhatsAppLink } from "@/components/whatsapp-link";
import { POLICY_PAGES, SITE } from "@/lib/site";
import { storeInfo, storeRead } from "@/lib/store/server";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { Money } from "@/components/money";

export const metadata: Metadata = { title: `Help · ${SITE.name}` };

/** The prototype's help topics (`tabs`); here they jump to the sections or open a policy. */
const TOPICS = [
  { href: "#help-delivery", label: "Delivery" },
  { href: "#help-faq", label: "FAQ" },
  { href: "#help-contact", label: "Contact" },
];

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
      <PageHead title="Help & policies" />
      <nav className="tabs" aria-label="Help topics">
        {TOPICS.map((topic) => (
          <a key={topic.href} href={topic.href} className="chip">
            {topic.label}
          </a>
        ))}
        {POLICY_PAGES.map((page) => (
          <Link key={page.path} href={page.path} prefetch={false} className="chip">
            {page.title}
          </Link>
        ))}
      </nav>
      <div className="prose help-prose">
        <section aria-labelledby="help-delivery" className="help-sec">
          <h2 id="help-delivery" className="h2">
            Delivery {emirates.length > 0 ? "across the UAE" : ""}
          </h2>
          {emirates.length > 0 ? (
            <p>We deliver to areas in {emirates.join(", ")}.</p>
          ) : (
            <p>
              Delivery areas are being set up. Message us on WhatsApp and we will tell you whether
              we can deliver to you.
            </p>
          )}
          <h3>Fee</h3>
          <p>
            {delivery.feeFils === null ? (
              "Shown with your total before you order."
            ) : delivery.feeFils === 0 ? (
              "Included in your total."
            ) : (
              <>
                <Money fils={delivery.feeFils} /> per order, the same in every emirate.
              </>
            )}
          </p>
          {delivery.etaText && (
            <>
              <h3>When it arrives</h3>
              <p>{delivery.etaText}</p>
            </>
          )}
          <h3>On delivery</h3>
          <ul>
            <li>Pay the courier in cash when your order arrives.</li>
            <li>Have the exact amount ready if you can.</li>
          </ul>
        </section>
        <section aria-labelledby="help-faq" className="help-sec">
          <h2 id="help-faq" className="h2">
            Frequently asked questions
          </h2>
          <div className="faq">
            {faq.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <Icon name="plus" />
                </summary>
                <p className="a">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
        <section aria-labelledby="help-contact" className="help-sec">
          <h2 id="help-contact" className="h2">
            Contact {SITE.name}
          </h2>
          {whatsappNumber ? (
            <>
              <p>The fastest way to reach us is WhatsApp.</p>
              <div className="co-actions">
                <WhatsAppLink
                  number={whatsappNumber}
                  message={WHATSAPP_MESSAGES.general(SITE.name)}
                  className="btn btn-wa"
                >
                  <Icon name="wa" size="sm" /> WhatsApp {whatsappNumber}
                </WhatsAppLink>
                <CopyButton text={whatsappNumber}>Copy number</CopyButton>
              </div>
            </>
          ) : (
            <p>Contact details will be published here shortly.</p>
          )}
        </section>
      </div>
    </>
  );
}
