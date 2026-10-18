import type { Metadata } from "next";
import { CartView } from "@/components/cart-view";
import { Breadcrumbs } from "@/components/listing";
import { SITE } from "@/lib/site";
import { storeHome, storeInfo } from "@/lib/store/server";

export const metadata: Metadata = { title: `Your cart · ${SITE.name}` };

/**
 * Cart page. The server renders only the frame: the cart itself lives on the shopper's device
 * and is drawn in the browser. Like every page here it is behind the routing gate.
 */
export default async function CartPage() {
  // Best sellers only for an empty cart with no history (G-S14); empty when they can't be read.
  const [{ whatsappNumber, checkoutOpen }, { bestSellers }] = await Promise.all([
    storeInfo(),
    storeHome(),
  ]);
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Cart" }]} />
      <CartView
        whatsappNumber={whatsappNumber}
        checkoutOpen={checkoutOpen}
        bestSellers={bestSellers}
      />
    </>
  );
}
