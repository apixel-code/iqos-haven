"use client";

import { useEffect } from "react";
import { normalizeSearchTerm } from "@ih/contracts";
import { track } from "@/lib/telemetry/client";

/**
 * Reports one search (step 104): the normalized term and how many products matched. A term
 * that may be a phone number, an email, a name or an address is sent as `null`; the API
 * applies the same rule again.
 */
export function TrackSearch({ term, total }: { term: string; total: number }) {
  useEffect(() => {
    // A term that may be personal never leaves the browser: only the fact of a search does.
    track({
      type: "search",
      term: normalizeSearchTerm(term),
      resultCount: Math.min(total, 100_000),
    });
  }, [term, total]);
  return null;
}
