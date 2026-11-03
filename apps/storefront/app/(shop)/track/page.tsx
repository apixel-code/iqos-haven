import type { Metadata } from "next";
import { OrderTracking } from "@/components/order-tracking";
import { SITE } from "@/lib/site";
import { storeInfo } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `Track your order · ${SITE.name}`,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Order tracking (ADR 0104). The server renders only the form: the number is typed in the
 * browser and posted to the API, so no order data passes through this server or its HTML, and
 * no query value is read. Behind the routing gate like every page.
 */
export default async function TrackPage() {
  const { whatsappNumber } = await storeInfo();
  return <OrderTracking whatsappNumber={whatsappNumber} />;
}
