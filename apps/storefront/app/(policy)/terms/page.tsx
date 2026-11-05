import type { Metadata } from "next";
import { readBusiness } from "@/lib/business";
import { SITE } from "@/lib/site";
import { PolicyPage, PolicySection, PolicyUpdated } from "../policy-page";

export const metadata: Metadata = { title: `Terms & conditions · ${SITE.name}` };

/**
 * Written from how the store works (ADR 0036 prices, BI-03 delivery, cash on delivery, order
 * states, ADR 0102 confirmation email); returns rules approved by the client 2026-11-02. Not
 * legal advice.
 */
export default async function TermsPage() {
  const { legalName, tradeLicence } = await readBusiness();
  return (
    <PolicyPage title="Terms & conditions">
      <PolicyUpdated />
      <p>
        These terms apply to every order placed on the {SITE.name} website. By placing an order, you
        agree to them. Please read them together with our privacy policy and our responsible use and
        age policy.
      </p>

      <p>
        {SITE.name} is an independent retailer. We are not affiliated with, endorsed by or sponsored
        by Philip Morris International; IQOS, ILUMA and TEREA are trademarks of their respective
        owners. Every product we sell is supplied in its original factory-sealed packaging.
      </p>

      {/* The Owner's details from Admin → Settings → Store (ADR 0106); hidden until entered. */}
      {(legalName || tradeLicence) && (
        <p>
          The store is operated by {legalName ?? SITE.name}
          {tradeLicence && <>, UAE trade licence no. {tradeLicence}</>}.
        </p>
      )}

      <PolicySection id="eligibility" title="1. Who can buy">
        <ul className="list-disc space-y-1 pl-5">
          <li>You must be 18 or older to enter the store and to place an order.</li>
          <li>We deliver only to addresses in the United Arab Emirates.</li>
          <li>
            We may ask for an Emirates ID or other proof of age at delivery. If you cannot show it,
            or appear to be under 18, the courier will not hand over the order and it will be
            cancelled.
          </li>
          <li>Orders must be for your own personal use, not for resale.</li>
        </ul>
      </PolicySection>

      <PolicySection id="products-prices" title="2. Products and prices">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            All prices are in UAE dirhams. The price shown is the final price for the product; there
            is no extra tax added at checkout.
          </li>
          <li>
            The delivery fee for your area is shown at checkout before you order, together with the
            total you will pay.
          </li>
          <li>
            Product photos are for illustration. Colours and packaging may differ slightly from what
            you see on screen.
          </li>
          <li>
            Prices and availability can change. The total shown when you place your order is the
            total you pay. If a price or the stock changes while you are checking out, we show you
            the new total and ask you to accept it before the order is placed.
          </li>
        </ul>
      </PolicySection>

      <PolicySection id="orders" title="3. Placing and confirming an order">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            When you place an order, you receive an order number on screen and an order confirmation
            by email. This means we have received your order; it is not yet accepted.
          </li>
          <li>
            We call or message you on the mobile number you gave to confirm the order before it is
            prepared. If we cannot reach you, we may cancel it.
          </li>
          <li>
            We may decline or cancel an order, for example if a product is out of stock, the address
            cannot be served, or the order appears to break these terms. If that happens, we tell
            you and you pay nothing.
          </li>
          <li>One discount code can be used per order. Codes cannot be combined.</li>
        </ul>
      </PolicySection>

      <PolicySection id="payment" title="4. Payment">
        <p>
          Payment is cash on delivery only. You pay the courier the order total in cash when your
          order arrives. Please have the exact amount ready if you can. We do not take card or
          online payments.
        </p>
      </PolicySection>

      <PolicySection id="delivery" title="5. Delivery">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            We deliver to the areas listed at checkout across the seven emirates. The delivery fee
            and the expected delivery time are shown at checkout.
          </li>
          <li>
            Delivery times are estimates. Delays can happen because of traffic, weather, public
            holidays or high demand; we will keep you informed.
          </li>
          <li>
            Please make sure someone aged 18 or over is available to receive the order and pay. If
            delivery fails because no one is available or the address is wrong, we will contact you
            to arrange another time. Repeated failed deliveries may lead to cancellation.
          </li>
          <li>Please check your order when it arrives and tell the courier about any problem.</li>
        </ul>
      </PolicySection>

      <PolicySection id="cancellation" title="6. Cancelling an order">
        <p>
          You can cancel your order free of charge at any time before it leaves for delivery.
          Message us on WhatsApp with your order number. Once the order is out for delivery, it can
          no longer be cancelled, but you may refuse it at the door if it has not been opened.
        </p>
      </PolicySection>

      <PolicySection id="returns" title="7. Returns and exchanges">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Tobacco sticks</strong> (such as TEREA) cannot be returned or exchanged once the
            pack or carton has been opened, for health and safety reasons. Unopened packs and
            cartons in their original sealed packaging can be returned within 7 days of delivery.
          </li>
          <li>
            <strong>Devices</strong> (such as IQOS ILUMA) that arrive damaged, faulty or not as
            ordered will be exchanged. Tell us within 7 days of delivery, with your order number and
            a photo or short video of the problem.
          </li>
          <li>
            A device that has been opened and used without a fault, or that was damaged after
            delivery through misuse, water or a fall, cannot be returned or exchanged.
          </li>
          <li>
            If we sent you the wrong item, we exchange it at no cost to you, including delivery.
          </li>
          <li>
            Where a refund applies, it is paid in cash or by a method we agree with you, within 14
            days after we receive the returned item.
          </li>
        </ul>
        <p>
          To start a return or exchange, message us on WhatsApp using the number on the Help page of
          our store.
        </p>
      </PolicySection>

      <PolicySection id="use" title="8. Using our products">
        <p>
          Our products contain nicotine, which is addictive. Use them only as the manufacturer
          instructs, keep them away from children and pets, and read our responsible use and age
          policy. We are not liable for harm caused by misuse of a product.
        </p>
      </PolicySection>

      <PolicySection id="liability" title="9. Our responsibility">
        <p>
          We take care to show accurate information and to deliver what you ordered. Our liability
          for an order is limited to the amount you paid for it, except where the law does not allow
          this limit. Nothing in these terms affects your rights under UAE consumer protection law.
        </p>
      </PolicySection>

      <PolicySection id="reviews" title="10. Reviews">
        <p>
          After delivery we may send you a link to review a product you bought. Reviews are checked
          before they are published, and we may decline reviews that are unrelated, abusive or
          include personal details.
        </p>
      </PolicySection>

      <PolicySection id="law" title="11. Governing law">
        <p>
          These terms are governed by the laws of the United Arab Emirates, and the courts of the
          United Arab Emirates have jurisdiction over any dispute.
        </p>
      </PolicySection>

      <PolicySection id="changes" title="12. Changes to these terms">
        <p>
          We may update these terms from time to time. The terms in force when you place an order
          apply to that order. The date at the top shows when they last changed.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
