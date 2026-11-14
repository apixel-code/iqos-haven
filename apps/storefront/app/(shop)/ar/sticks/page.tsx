import type { Metadata } from "next";
import { AR, languageAlternates } from "@/lib/ar";
import { SITE } from "@/lib/site";
import { ListingPage } from "../../listing-page";

export const metadata: Metadata = {
  title: `${AR.sticks} · ${SITE.name}`,
  description: AR.sticksLead,
  alternates: languageAlternates("/ar/sticks", "ar"),
};

/** Arabic listing (ADR 0120): the same products and filters as /sticks, with an Arabic heading. */
export default function ArabicSticksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <div lang="ar" dir="rtl">
      <ListingPage
        path="/ar/sticks"
        searchParams={searchParams}
        fixed={{ type: "sticks" }}
        trail={[{ label: AR.home, href: "/ar" }, { label: AR.sticks }]}
        head={{ title: AR.sticks, lead: AR.sticksLead }}
        emptyBody={AR.noProducts}
      />
    </div>
  );
}
