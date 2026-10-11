import type { Metadata } from "next";
import { AGE_COPY } from "@/lib/age/copy";
import { GateShell } from "../gate-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Access restricted · Iqos Haven" };

/** Shown after an under-age answer. No way into the store from here, and no catalogue data. */
export default function RestrictedPage() {
  return (
    <GateShell labelledBy="restricted-title">
      <div className="flex flex-col gap-3">
        <h1 id="restricted-title" className="text-2xl font-semibold tracking-tight">
          {AGE_COPY.restrictedTitle}
        </h1>
        <p className="text-base text-ink-2">{AGE_COPY.restrictedLead}</p>
      </div>
      <div>
        <a
          href="https://www.google.com"
          rel="noopener noreferrer"
          className="inline-flex h-12 items-center justify-center rounded-pill border border-line-2 bg-surface px-6 text-base font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {AGE_COPY.leave}
        </a>
      </div>
    </GateShell>
  );
}
