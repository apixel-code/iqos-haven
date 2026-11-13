import type { Metadata } from "next";
import type { ReactNode } from "react";
import { readSeoPolicy } from "@/lib/seo-policy";

/**
 * The public policy pages may be offered to search engines when the Owner chose "public pages"
 * (step 113, ADR 0079) or the whole catalogue (ADR 0114); otherwise they keep the store-wide
 * noindex. They hold no catalogue data. Links are followed only when the catalogue is offered.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { indexing } = await readSeoPolicy();
  return { robots: { index: indexing !== "closed", follow: indexing === "catalogue" } };
}

export default function PolicyLayout({ children }: { children: ReactNode }) {
  return children;
}
