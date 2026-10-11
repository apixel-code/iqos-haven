import { fils } from "./money";
export class DeliveryUnavailableError extends Error {}
export class DeliveryUnconfiguredError extends Error {}
/** An order can only go to an active Dubai area. */
export function isDeliverableArea(area: { active: boolean; emirate: string } | null | undefined) {
  return !!area && area.active && area.emirate === "dubai";
}
/** Launch rule: one flat fee for an active Dubai area. No free threshold or client fee. */
export function deliveryForArea(
  configuration: { flatFeeFils: number; etaText: string; freeThresholdFils: null } | null,
  area: { active: boolean; emirate: string } | null,
) {
  if (!isDeliverableArea(area)) throw new DeliveryUnavailableError();
  if (!configuration) throw new DeliveryUnconfiguredError();
  return { feeFils: fils(configuration.flatFeeFils), etaText: configuration.etaText };
}
