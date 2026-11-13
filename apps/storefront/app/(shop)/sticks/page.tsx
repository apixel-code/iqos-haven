import type { Metadata } from "next";
import { TYPE_PAGES } from "@/lib/store/listing";
import { pageDescription, SITE } from "@/lib/site";
import { ListingPage } from "../listing-page";

const PAGE = TYPE_PAGES.sticks;
export const metadata: Metadata = {
  title: `${PAGE.title} · ${SITE.name}`,
  description: pageDescription("TEREA sticks for IQOS ILUMA, by version and flavour."),
  alternates: { canonical: PAGE.path },
};

export default function SticksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <ListingPage
      path={PAGE.path}
      searchParams={searchParams}
      fixed={{ type: "sticks" }}
      trail={[{ label: "Home", href: "/" }, { label: PAGE.title }]}
      head={{ title: PAGE.title, lead: PAGE.lead }}
      emptyBody="Products will appear here as soon as they are available."
    />
  );
}
