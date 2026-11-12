import { fils } from "./money";
export class DeliveryUnavailableError extends Error {}
export class DeliveryUnconfiguredError extends Error {}
/** Delivery covers the seven emirates (BI-03, ADR 0036). */
export const UAE_EMIRATES = [
  "abu_dhabi",
  "dubai",
  "sharjah",
  "ajman",
  "umm_al_quwain",
  "ras_al_khaimah",
  "fujairah",
] as const;
export type Emirate = (typeof UAE_EMIRATES)[number];
export const EMIRATE_NAMES: Record<Emirate, string> = {
  abu_dhabi: "Abu Dhabi",
  dubai: "Dubai",
  sharjah: "Sharjah",
  ajman: "Ajman",
  umm_al_quwain: "Umm Al Quwain",
  ras_al_khaimah: "Ras Al Khaimah",
  fujairah: "Fujairah",
};
/** An order can only go to an active area in one of the emirates. */
export function isDeliverableArea(area: { active: boolean; emirate: string } | null | undefined) {
  return !!area && area.active && (UAE_EMIRATES as readonly string[]).includes(area.emirate);
}
/**
 * One flat fee for any active UAE area (BI-03), and optionally free delivery from a threshold
 * (ADR 0113): `freeThresholdFils` null means free delivery is off.
 */
export function deliveryForArea(
  configuration: { flatFeeFils: number; etaText: string; freeThresholdFils: number | null } | null,
  area: { active: boolean; emirate: string } | null,
) {
  if (!isDeliverableArea(area)) throw new DeliveryUnavailableError();
  if (!configuration) throw new DeliveryUnconfiguredError();
  return {
    feeFils: fils(configuration.flatFeeFils),
    etaText: configuration.etaText,
    freeThresholdFils:
      configuration.freeThresholdFils === null ? null : fils(configuration.freeThresholdFils),
  };
}
/**
 * The fee an order pays (ADR 0113): nothing when the merchandise after any coupon discount
 * reaches the free-delivery threshold, otherwise the flat fee. The threshold counts what the
 * shopper pays for the goods, so a coupon cannot carry an order below it into free delivery.
 */
export function deliveryFeeFor(
  delivery: { feeFils: number; freeThresholdFils: number | null },
  merchandiseAfterDiscountFils: number,
): number {
  const after = fils(merchandiseAfterDiscountFils);
  if (delivery.freeThresholdFils !== null && after >= fils(delivery.freeThresholdFils)) return 0;
  return fils(delivery.feeFils);
}
