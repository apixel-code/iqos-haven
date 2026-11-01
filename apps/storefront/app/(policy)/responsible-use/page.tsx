import type { Metadata } from "next";
import { MINIMUM_AGE } from "@/lib/age/copy";
import { SITE } from "@/lib/site";
import { PolicyPage, PolicySection, PolicyUpdated } from "../policy-page";

export const metadata: Metadata = { title: `Responsible use · ${SITE.name}` };

/**
 * Age policy as built (BI-04: 18+, server-checked gate, 30-day confirmation) and general
 * nicotine warnings; approved by the client 2026-11-02. Not medical or legal advice.
 */
export default function ResponsibleUsePage() {
  return (
    <PolicyPage title="Responsible use and age policy">
      <PolicyUpdated />
      <p>
        {SITE.name} sells IQOS heated-tobacco devices and TEREA tobacco sticks to adults aged{" "}
        {MINIMUM_AGE} and over only. These products are not a safe alternative to not using tobacco
        or nicotine at all.
      </p>

      <PolicySection id="warnings" title="1. Health warnings">
        <ul className="list-disc space-y-1 pl-5">
          <li>These products contain nicotine. Nicotine is highly addictive.</li>
          <li>
            Our products are not intended for non-smokers, people under {MINIMUM_AGE}, or pregnant
            or breastfeeding women.
          </li>
          <li>
            Ask a doctor before use if you have a heart condition, high blood pressure, diabetes or
            any other medical condition, or if you take medication.
          </li>
          <li>
            If you do not smoke or use nicotine, do not start. The best choice for your health is to
            quit tobacco and nicotine completely.
          </li>
        </ul>
      </PolicySection>

      <PolicySection id="age-policy" title={`2. Our ${MINIMUM_AGE}+ age policy`}>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Every visitor must confirm they are {MINIMUM_AGE} or older before they can see our
            products. Visitors who do not confirm cannot enter the store.
          </li>
          <li>
            Your confirmation is remembered on your device for up to 30 days, after which we ask
            again.
          </li>
          <li>
            At checkout you confirm your age again. The courier may ask for an Emirates ID or other
            proof of age at delivery and will not hand over an order to anyone under {MINIMUM_AGE}.
          </li>
          <li>Do not buy our products for anyone under {MINIMUM_AGE}.</li>
        </ul>
      </PolicySection>

      <PolicySection id="safe-use" title="3. Using devices safely">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Keep devices, tobacco sticks and used sticks out of reach of children and pets.
            Swallowing tobacco or nicotine can be dangerous; seek medical help at once if this
            happens.
          </li>
          <li>Use only genuine TEREA sticks with IQOS ILUMA devices, as the maker instructs.</li>
          <li>
            Charge devices with the supplied cable and a suitable charger. Do not leave a charging
            device unattended for long periods, and do not use a device that is damaged, swollen or
            wet.
          </li>
          <li>Dispose of used sticks in a bin, never on the street or in nature.</li>
          <li>Respect no-smoking rules in public places, at work and on public transport.</li>
        </ul>
      </PolicySection>

      <PolicySection id="parents" title="4. For parents and guardians">
        <p>
          If you believe a person under {MINIMUM_AGE} has ordered from us, message us on WhatsApp
          using the number on the Help page of our store, and we will cancel the order.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
