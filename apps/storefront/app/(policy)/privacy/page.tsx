import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { PolicyPage, PolicySection, PolicyUpdated } from "../policy-page";

export const metadata: Metadata = { title: `Privacy policy · ${SITE.name}` };

/**
 * Written from what the store actually does (checkout fields, ADR 0102 email, device storage,
 * BI-08 retention defaults); approved by the client 2026-11-02. Not legal advice.
 */
export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy policy">
      <PolicyUpdated />
      <p>
        This policy explains what information {SITE.name} collects when you use our website and
        place an order, why we collect it, how long we keep it and the choices you have. We only
        collect what we need to sell and deliver your order.
      </p>

      <PolicySection id="what-we-collect" title="1. What we collect">
        <p>When you place an order, we collect:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>your full name;</li>
          <li>your UAE mobile number;</li>
          <li>your email address;</li>
          <li>
            your delivery address: area and emirate, building or villa, apartment or office number,
            street or landmark, Makani number and delivery notes, if you give them;
          </li>
          <li>what you ordered, the prices, the delivery fee and the total;</li>
          <li>your confirmation that you are 18 or older.</li>
        </ul>
        <p>
          We do not ask for card or bank details. You pay in cash when your order is delivered, and
          we do not process any online payment.
        </p>
        <p>
          You do not need an account to shop with us. We do not create customer accounts or
          passwords.
        </p>
      </PolicySection>

      <PolicySection id="how-we-use" title="2. How we use your information">
        <ul className="list-disc space-y-1 pl-5">
          <li>to confirm your order with you by phone or WhatsApp;</li>
          <li>to deliver your order to your address and collect payment;</li>
          <li>to send your order confirmation to your email;</li>
          <li>to answer your questions and handle returns or exchanges;</li>
          <li>
            to send you a link to review a product you received, if you agree to leave a review;
          </li>
          <li>to keep the records the law requires and to prevent fraud and misuse.</li>
        </ul>
        <p>
          We do not sell your information, and we do not send marketing messages without asking.
        </p>
      </PolicySection>

      <PolicySection id="your-device" title="3. What stays on your device">
        <p>
          When you confirm your age, we store a signed age confirmation in a cookie on your device
          for up to 30 days, so you are not asked again on every visit. It contains no personal
          details.
        </p>
        <p>
          Your cart, saved items, product comparison and recently viewed products are kept in your
          browser&apos;s storage on your device. They are not sent to us until you place an order.
          The details you type at checkout are kept only in the open page and are not saved in your
          browser.
        </p>
        <p>
          After you place an order, a short-lived cookie lets this device show your order
          confirmation page. It expires after 30 minutes.
        </p>
        <p>
          We count anonymous page and product views to understand what shoppers look for. These
          counts do not include your name, phone, email or address.
        </p>
      </PolicySection>

      <PolicySection id="sharing" title="4. Who we share it with">
        <p>
          We share your information only with the people and services that help us run the store,
          and only as much as they need:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>our staff and couriers, to confirm and deliver your order;</li>
          <li>our email provider, to send your order confirmation;</li>
          <li>our hosting and backup providers, which store our data securely;</li>
          <li>authorities, when the law requires it.</li>
        </ul>
      </PolicySection>

      <PolicySection id="retention" title="5. How long we keep it">
        <ul className="list-disc space-y-1 pl-5">
          <li>Order records (what was ordered, prices and status) are kept as business records.</li>
          <li>
            Your name, mobile number, email and addresses are anonymised five years after your last
            order, or sooner if you ask us and the law allows it.
          </li>
          <li>Anonymous view counts are kept for 90 days; daily totals are kept longer.</li>
          <li>Backups are kept for 30 days and then deleted.</li>
        </ul>
      </PolicySection>

      <PolicySection id="security" title="6. How we protect it">
        <p>
          Our website uses an encrypted connection (HTTPS). Only authorised staff can see customer
          details, and every change to an order is recorded. Backups are encrypted.
        </p>
      </PolicySection>

      <PolicySection id="your-choices" title="7. Your choices">
        <p>
          You can ask us what information we hold about you, ask us to correct it, or ask us to
          delete or anonymise it where the law allows. You can also clear the cookies and storage on
          your device at any time; you will then be asked to confirm your age again.
        </p>
        <p>
          To make a request, message us on WhatsApp using the number on the Help page of our store.
          We may ask you to confirm the mobile number you ordered with.
        </p>
      </PolicySection>

      <PolicySection id="age" title="8. Adults only">
        <p>
          Our store is for adults aged 18 and over. We do not knowingly collect information from
          anyone under 18.
        </p>
      </PolicySection>

      <PolicySection id="changes" title="9. Changes to this policy">
        <p>
          We may update this policy from time to time. The date at the top shows when it last
          changed.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
