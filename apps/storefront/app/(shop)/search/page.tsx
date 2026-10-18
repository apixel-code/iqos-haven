import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { ListingPage } from "../listing-page";

// The search term never goes into the title: titles are generic until a result is opened.
export const metadata: Metadata = { title: `Search · ${SITE.name}` };

/** Search and filtered browsing (prototype shop view with a query). */
export default function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <ListingPage
      search
      path="/search"
      searchParams={searchParams}
      trail={[{ label: "Home", href: "/" }, { label: "Search" }]}
      emptyBody="Nothing in the catalogue yet."
    />
  );
}
