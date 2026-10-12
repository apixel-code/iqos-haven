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
/** Launch rule: one flat fee for any active UAE area. No free threshold or client fee. */
export function deliveryForArea(
  configuration: { flatFeeFils: number; etaText: string; freeThresholdFils: null } | null,
  area: { active: boolean; emirate: string } | null,
) {
  if (!isDeliverableArea(area)) throw new DeliveryUnavailableError();
  if (!configuration) throw new DeliveryUnconfiguredError();
  return { feeFils: fils(configuration.flatFeeFils), etaText: configuration.etaText };
}
