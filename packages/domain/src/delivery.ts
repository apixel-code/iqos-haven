import { fils } from "./money";
export class DeliveryUnavailableError extends Error {}
export class DeliveryUnconfiguredError extends Error {}
/** Launch rule: one flat fee for an active Dubai area. No free threshold or client fee. */
export function deliveryForArea(
  configuration: { flatFeeFils: number; etaText: string; freeThresholdFils: null } | null,
  area: { active: boolean; emirate: string } | null,
) {
  if (!area?.active || area.emirate !== "dubai") throw new DeliveryUnavailableError();
  if (!configuration) throw new DeliveryUnconfiguredError();
  return { feeFils: fils(configuration.flatFeeFils), etaText: configuration.etaText };
}
