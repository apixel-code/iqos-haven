import type { Metadata } from "next";
import { Button } from "@ih/ui-core";
import { AGE_COPY } from "@/lib/age/copy";
import { safeReturnPath } from "@/lib/age/policy";
import { ageGate } from "@/lib/age/runtime";
import { GateShell } from "../gate-shell";

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
      <div className="flex flex-col gap-3">
        <h1 id="gate-q" className="text-3xl font-semibold tracking-tight">
          {AGE_COPY.question}
        </h1>
        <p className="text-base text-ink-2">{AGE_COPY.lead}</p>
      </div>
      <div
        role="group"
        aria-label="Confirm your age"
        className="flex flex-col gap-3 sm:flex-row sm:justify-center"
      >
        <form method="post" action="/api/age/accept" className="contents">
          <input type="hidden" name="return" value={target} />
          <Button type="submit" size="lg" className="w-full sm:w-auto">
            {AGE_COPY.accept}
          </Button>
        </form>
        <form method="post" action="/api/age/reject" className="contents">
          <Button type="submit" size="lg" variant="secondary" className="w-full sm:w-auto">
            {AGE_COPY.reject}
          </Button>
        </form>
      </div>
      <p className="text-xs text-ink-2">{AGE_COPY.fine(days)}</p>
    </GateShell>
  );
}
