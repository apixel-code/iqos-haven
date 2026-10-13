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
      <PageHead title="Checkout" lead="Guest checkout. No account needed, pay when it arrives." />
      {checkoutOpen ? (
        <CheckoutView />
      ) : (
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-ink-2">Checkout is not open yet.</p>
          <Link href="/cart" prefetch={false} className="text-sm underline underline-offset-2">
            Back to cart
          </Link>
        </div>
      )}
    </>
  );
}
