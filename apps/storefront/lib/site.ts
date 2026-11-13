import { MINIMUM_AGE } from "./age/copy";

/**
 * The only store facts an unverified visitor, a link-preview fetcher or an unverified crawler
 * may see (architecture §9 "Search indexing and social previews", ADR 0026): a consistent store
 * name and a generic description. Never a product name, image, price, SKU or JSON-LD.
 */
export const SITE = {
  name: "Iqos Haven",
  description: `Adults-only store delivering across the UAE. ${MINIMUM_AGE}+.`,
} as const;

/**
 * Meta description of a catalogue page (ADR 0114): what the page lists, then how the store
 * delivers. Only pages behind the routing gate use it.
 */
export const pageDescription = (subject: string) =>
  `${subject} Delivery across the UAE, cash on delivery. Adults only, ${MINIMUM_AGE}+.`;

/**
 * Public policy pages (prototype "Legal" links). Reachable without the age check and free of
 * catalogue data. Text drafted by Apixel from the store's actual rules and approved by the client
 * (2026-11-02); not legal advice, and open to the client's legal adviser (BI-04).
 */
export const POLICY_PAGES = [
  { path: "/responsible-use", title: "Responsible use" },
  { path: "/terms", title: "Terms & conditions" },
  { path: "/privacy", title: "Privacy policy" },
] as const;
export type PolicyPath = (typeof POLICY_PAGES)[number]["path"];

/**
 * Primary navigation. Kept here, not in a client component file: a value exported from a
 * "use client" module is a client reference when a server component imports it, not an array.
 */
export const PRIMARY_NAV = [
  { href: "/shop", label: "Shop" },
  { href: "/devices", label: "IQOS devices" },
  { href: "/sticks", label: "TEREA sticks" },
  { href: "/brands", label: "Brands" },
  { href: "/offers", label: "Offers" },
] as const;
