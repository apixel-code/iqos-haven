import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { PendingText, PolicyPage } from "../policy-page";

export const metadata: Metadata = { title: `Privacy policy · ${SITE.name}` };

export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy policy">
      <p>
        This site remembers your age confirmation on your device. Your cart and saved items are also
        kept on your device.
      </p>
      <p>
        When you place an order, we use your name, mobile number, email and delivery address to
        confirm and deliver it, and we send your order confirmation to your email.
      </p>
      <PendingText />
    </PolicyPage>
  );
}
