import type { Metadata } from "next";
import type { ReactNode } from "react";
import { readSeoPolicy } from "@/lib/seo-policy";

/**
 * The public policy pages may be offered to search engines when the Owner chose "public pages"
 * (step 113, ADR 0079); otherwise they keep the store-wide noindex. They hold no catalogue data.
 */
export async function generateMetadata(): Promise<Metadata> {
  const policy = await readSeoPolicy();
  return policy.indexing === "public_pages"
    ? { robots: { index: true, follow: false } }
    : { robots: { index: false, follow: false } };
}

export default function PolicyLayout({ children }: { children: ReactNode }) {
  return children;
}
