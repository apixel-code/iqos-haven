import type { Metadata } from "next";
import { MINIMUM_AGE } from "@/lib/age/copy";
import { SITE } from "@/lib/site";
import { PendingText, PolicyPage } from "../policy-page";

export const metadata: Metadata = { title: `Responsible use · ${SITE.name}` };

/** Prototype wording; final wording and required health warnings are pending (BI-04). */
export default function ResponsibleUsePage() {
  return (
    <PolicyPage title="Responsible use and age policy">
      <p>
        {SITE.name} sells nicotine products to adults aged {MINIMUM_AGE} and over only. Visitors
        confirm their age before entering the store.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Our products are not intended for non-smokers, people under {MINIMUM_AGE}, or pregnant or
          breastfeeding women.
        </li>
        <li>Nicotine is an addictive substance.</li>
        <li>Keep devices and e-liquids out of reach of children.</li>
      </ul>
      <PendingText />
    </PolicyPage>
  );
}
