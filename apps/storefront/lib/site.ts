import { MINIMUM_AGE } from "./age/copy";

/**
 * The only store facts an unverified visitor, a link-preview fetcher or a crawler may see
 * (architecture §9 "Search indexing and social previews", ADR 0026): a consistent store name
 * and a generic description. Never a product name, image, price, SKU or JSON-LD.
 */
export const SITE = {
  name: "Iqos Haven",
  description: `Adults-only store in Dubai. ${MINIMUM_AGE}+.`,
} as const;

/**
 * Public policy pages (prototype "Legal" links). Reachable without the age check and free of
 * catalogue data. Their final text comes from the client's legal adviser (BI-04/BI-05); until
 * then each page says so instead of showing invented legal wording.
 */
export const POLICY_PAGES = [
  { path: "/responsible-use", title: "Responsible use" },
  { path: "/terms", title: "Terms & conditions" },
  { path: "/privacy", title: "Privacy policy" },
] as const;
export type PolicyPath = (typeof POLICY_PAGES)[number]["path"];
