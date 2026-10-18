import type { Metadata } from "next";
import { AGE_COPY } from "@/lib/age/copy";
import { Icon } from "@/components/icons";
import { GateShell } from "../gate-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Access restricted · Iqos Haven" };

/** Shown after an under-age answer. No way into the store from here, and no catalogue data. */
export default function RestrictedPage() {
  return (
    <GateShell labelledBy="restricted-title" restricted>
      <div className="gate-seal lock" aria-hidden="true">
        <Icon name="lock" size="xl" />
      </div>
      <div className="gate-text">
        <h1 id="restricted-title">{AGE_COPY.restrictedTitle}</h1>
        <p className="lead">{AGE_COPY.restrictedLead}</p>
      </div>
      <div>
        <a
          href="https://www.google.com"
          rel="noopener noreferrer"
          className="btn btn-outline btn-lg"
        >
          {AGE_COPY.leave} <Icon name="external" size="sm" />
        </a>
      </div>
    </GateShell>
  );
}
