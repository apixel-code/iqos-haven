import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { ListingPage } from "../listing-page";

export const metadata: Metadata = { title: `Offers · ${SITE.name}` };

/**
 * Offers (roadmap step 100; prototype shop view with the sale filter): products the API shows
 * with a reduced price, the same rule as a card's "was" price. No coupon codes are advertised
 * here (BI-13); a code is entered in the cart and the server decides what it does.
 */
export default function OffersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <ListingPage
      path="/offers"
      searchParams={searchParams}
      fixed={{ sale: true }}
      trail={[{ label: "Home", href: "/" }, { label: "Offers" }]}
      head={{ title: "Offers", lead: "Products currently available at a reduced price." }}
      emptyBody="There are no reduced prices right now. New offers appear here as soon as they start."
    />
  );
}
