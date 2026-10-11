import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { PendingText, PolicyPage } from "../policy-page";

export const metadata: Metadata = { title: `Terms & conditions · ${SITE.name}` };

export default function TermsPage() {
  return (
    <PolicyPage title="Terms & conditions">
      <PendingText />
    </PolicyPage>
  );
}
