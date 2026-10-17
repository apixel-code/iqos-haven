import type { Metadata } from "next";
import { OrderConfirmation } from "@/components/order-confirmation";
import { SITE } from "@/lib/site";
import { storeInfo } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `Your order · ${SITE.name}`,
  // The address of this page says nothing, and it must not travel anywhere either.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Order confirmation page (roadmap step 81). The server renders only the frame: the order is
 * read in the browser from the API with the confirmation cookie, so no order data passes
 * through this server or its HTML. No query or path value is read. Behind the routing gate.
 */
export default async function OrderConfirmationPage() {
  const { whatsappNumber } = await storeInfo();
  return <OrderConfirmation whatsappNumber={whatsappNumber} />;
}
