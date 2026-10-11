import type { Metadata } from "next";
import { TYPE_PAGES } from "@/lib/store/listing";
import { SITE } from "@/lib/site";
import { ListingPage } from "../listing-page";

const PAGE = TYPE_PAGES.disposable;
export const metadata: Metadata = { title: `${PAGE.title} · ${SITE.name}` };

export default function DisposableVapesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <ListingPage
      path={PAGE.path}
      searchParams={searchParams}
      fixed={{ type: "disposable" }}
      trail={[{ label: "Home", href: "/" }, { label: PAGE.title }]}
      head={{ title: PAGE.title, lead: PAGE.lead }}
      emptyBody="Products will appear here as soon as they are available."
    />
  );
}
