import type { Metadata } from "next";
import { AR, languageAlternates } from "@/lib/ar";
import { SITE } from "@/lib/site";
import { ListingPage } from "../../listing-page";

export const metadata: Metadata = {
  title: `${AR.devices} · ${SITE.name}`,
  description: AR.devicesLead,
  alternates: languageAlternates("/ar/devices", "ar"),
};

/** Arabic listing (ADR 0120): the same products and filters as /devices, with an Arabic heading. */
export default function ArabicDevicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <div lang="ar" dir="rtl">
      <ListingPage
        path="/ar/devices"
        searchParams={searchParams}
        fixed={{ type: "device" }}
        trail={[{ label: AR.home, href: "/ar" }, { label: AR.devices }]}
        head={{ title: AR.devices, lead: AR.devicesLead }}
        emptyBody={AR.noProducts}
      />
    </div>
  );
}
