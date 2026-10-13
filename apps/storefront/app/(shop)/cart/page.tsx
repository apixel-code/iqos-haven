import type { Metadata } from "next";
import { CartView } from "@/components/cart-view";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { SITE } from "@/lib/site";
import { storeInfo } from "@/lib/store/server";

export const metadata: Metadata = { title: `Your cart · ${SITE.name}` };

/**
 * Cart page. The server renders only the frame: the cart itself lives on the shopper's device
 * and is drawn in the browser. Like every page here it is behind the routing gate.
 */
export default async function CartPage() {
  const { whatsappNumber, checkoutOpen } = await storeInfo();
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Cart" }]} />
      <PageHead title="Your cart" />
      <CartView whatsappNumber={whatsappNumber} checkoutOpen={checkoutOpen} />
    </>
  );
}
