import type { Metadata } from "next";
import Link from "next/link";
import { CheckoutView } from "@/components/checkout-view";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { SITE } from "@/lib/site";
import { storeInfo } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `Checkout · ${SITE.name}`,
  // What is typed here must not travel anywhere in a Referer header.
  referrer: "no-referrer",
};

/**
 * Checkout page (roadmap step 80). The server renders only the frame and whether the shop is
 * taking orders; the cart, the form and the total are drawn in the browser, and nothing typed
 * into the form is ever sent to this server. Behind the routing gate like every page here.
 */
export default async function CheckoutPage() {
  const { checkoutOpen } = await storeInfo();
  return (
    <>
      <Breadcrumbs
        trail={[
          { label: "Home", href: "/" },
          { label: "Cart", href: "/cart" },
          { label: "Checkout" },
        ]}
      />
      <PageHead title="Checkout" lead="Guest checkout. Four short steps, no account." />
      {checkoutOpen ? (
        <CheckoutView />
      ) : (
        <div className="co-wait">
          <p className="muted">Checkout is not open yet.</p>
          <Link href="/cart" prefetch={false} className="link">
            Back to cart
          </Link>
        </div>
      )}
    </>
  );
}
