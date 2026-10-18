import type { Metadata } from "next";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { SavedView } from "@/components/saved-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: `Saved items · ${SITE.name}` };

/** Saved items live on the shopper's device; the server renders only the frame. */
export default function WishlistPage() {
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Saved items" }]} />
      <PageHead
        title="Saved items"
        lead="Saved on this device. No account needed."
        leadIcon="phone"
      />
      <SavedView />
    </>
  );
}
