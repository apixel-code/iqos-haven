import type { Metadata } from "next";
import { AGE_COPY } from "@/lib/age/copy";
import { safeReturnPath } from "@/lib/age/policy";
import { ageGate } from "@/lib/age/runtime";
import { GateShell } from "../gate-shell";
import { KeepFragment } from "./keep-fragment";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Age check · Iqos Haven" };

/**
 * The age question. Two plain form posts, so it works without JavaScript; the handlers set or
 * clear the HttpOnly cookie. Nothing about the catalogue is rendered or linked here.
 */
export default async function AgeCheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).return;
  const target = safeReturnPath(typeof raw === "string" ? raw : null);
  const days = Math.round(ageGate().runtime.ticketTtlSeconds / 86_400);
  return (
    <GateShell labelledBy="gate-q">
      <div className="gate-seal" aria-hidden="true">
        18+
      </div>
      <div className="gate-text">
        <h1 id="gate-q">{AGE_COPY.question}</h1>
        <p className="lead">{AGE_COPY.lead}</p>
      </div>
      {/* Two plain form posts: they work without JavaScript and set or clear the cookie. */}
      <div className="gate-actions" role="group" aria-label="Confirm your age">
        <form id="age-accept" method="post" action="/api/age/accept">
          <input type="hidden" name="return" value={target} />
          <button type="submit" className="btn btn-primary">
            {AGE_COPY.accept}
          </button>
        </form>
        <form method="post" action="/api/age/reject">
          <button type="submit" className="btn btn-outline">
            {AGE_COPY.reject}
          </button>
        </form>
      </div>
      <p className="gate-fine">{AGE_COPY.fine(days)}</p>
      <KeepFragment formId="age-accept" />
    </GateShell>
  );
}
