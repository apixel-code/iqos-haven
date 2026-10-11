import type { PublishRequirement } from "@ih/contracts";

const LABELS: Record<PublishRequirement, string> = {
  tax_treatment: "Approved VAT/excise treatment (waiting for the accountant's decision)",
  active_variant: "At least one active variant",
  default_variant: "An active default variant",
  image: "At least one image",
  description: "A description of at least 20 characters",
  price: "A price above 0",
  puff_count: "Puffs (approx.) for disposables",
  live_brand_category: "A brand and category that are not in Trash",
  not_trashed: "Restore the product from Trash",
};
export function requirementLabel(requirement: PublishRequirement) {
  return LABELS[requirement];
}
