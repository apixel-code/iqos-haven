import {
  EMIRATE_NAMES,
  UAE_EMIRATES,
  type Emirate,
  type StoreDeliveryResponse,
} from "@ih/contracts";

/**
 * Delivery pages per emirate (ADR 0118). The address uses a readable slug; the facts on the
 * page (fee, time, areas) come from the Owner's delivery settings, never from copy, and a page
 * exists only while the Owner serves at least one active area in that emirate.
 */
export const EMIRATE_SLUGS: Readonly<Record<Emirate, string>> = {
  abu_dhabi: "abu-dhabi",
  dubai: "dubai",
  sharjah: "sharjah",
  ajman: "ajman",
  umm_al_quwain: "umm-al-quwain",
  ras_al_khaimah: "ras-al-khaimah",
  fujairah: "fujairah",
};
export const emirateOfSlug = (slug: string): Emirate | null =>
  UAE_EMIRATES.find((emirate) => EMIRATE_SLUGS[emirate] === slug) ?? null;

export interface ServedEmirate {
  emirate: Emirate;
  name: string;
  slug: string;
  areas: string[];
}
/** The emirates with at least one active area, in the fixed emirate order, areas sorted by name. */
export function servedEmirates(delivery: StoreDeliveryResponse): ServedEmirate[] {
  return UAE_EMIRATES.flatMap((emirate) => {
    const areas = delivery.areas
      .filter((area) => area.emirate === emirate)
      .map((area) => area.name)
      .sort((a, b) => a.localeCompare(b));
    return areas.length
      ? [{ emirate, name: EMIRATE_NAMES[emirate], slug: EMIRATE_SLUGS[emirate], areas }]
      : [];
  });
}
