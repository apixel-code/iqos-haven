import type { Metadata } from "next";
import { CompareView } from "@/components/compare-view";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { SITE } from "@/lib/site";
import { TYPE_PAGES } from "@/lib/store/listing";

export const metadata: Metadata = { title: `Compare kits · ${SITE.name}` };

/** The comparison lives on the shopper's device; the server renders only the frame. */
export default function ComparePage() {
  return (
    <>
      <Breadcrumbs
        trail={[
          { label: "Home", href: "/" },
          { label: "Vape Kits", href: TYPE_PAGES.kit.path },
          { label: "Compare" },
        ]}
      />
      <PageHead
        title="Compare kits"
        lead="Side by side, up to three. The best value in a row is highlighted."
      />
      <CompareView />
    </>
  );
}
