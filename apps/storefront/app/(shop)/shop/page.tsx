import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { ListingPage } from "../listing-page";

export const metadata: Metadata = { title: `All products · ${SITE.name}` };

export default function ShopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <ListingPage
      path="/shop"
      searchParams={searchParams}
      trail={[{ label: "Home", href: "/" }, { label: "Shop" }]}
      head={{ title: "All products", lead: "Every product we stock, filtered your way." }}
      emptyBody="Products will appear here as soon as they are available."
    />
  );
}
