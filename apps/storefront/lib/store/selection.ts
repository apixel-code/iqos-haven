import type { StoreProductResponse } from "@ih/contracts";

/**
 * Option selection for a product (roadmap step 61, ADR 0030). Pure rules shared by the product
 * page and quick add:
 * - the shopper's choice is never replaced: if the chosen combination is sold out or not
 *   offered, the answer is "sold out" / "unavailable", never another variant;
 * - nothing is chosen on the shopper's behalf, except an option that has only one value on
 *   offer (there is nothing to choose);
 * - price and availability always come from the one variant the choices identify.
 */
export type Variant = StoreProductResponse["variants"][number];
export type Chosen = Readonly<Record<string, string>>;

export interface OfferedOption {
  name: string;
  /** Values at least one active variant has, in the product's own order. */
  values: string[];
}

/** The options a shopper actually has to decide, limited to values that are on offer. */
export function offeredOptions(
  product: Pick<StoreProductResponse, "options" | "variants">,
): OfferedOption[] {
  return product.options
    .map((option) => ({
      name: option.name,
      values: option.values.filter((value) =>
        product.variants.some((variant) => variant.attributes[option.name] === value),
      ),
    }))
    .filter((option) => option.values.length > 0);
}

/** Choices that are not choices: options with a single value on offer. */
export function impliedChoices(options: readonly OfferedOption[]): Record<string, string> {
  return Object.fromEntries(
    options.filter((option) => option.values.length === 1).map((o) => [o.name, o.values[0]!]),
  );
}

const matches = (variant: Variant, chosen: Chosen, except?: string) =>
  Object.entries(chosen).every(
    ([name, value]) => name === except || variant.attributes[name] === value,
  );

/** How one value looks given what is chosen for the OTHER options. */
export function valueState(
  variants: readonly Variant[],
  chosen: Chosen,
  name: string,
  value: string,
): "available" | "sold_out" | "not_offered" {
  const candidates = variants.filter(
    (variant) => variant.attributes[name] === value && matches(variant, chosen, name),
  );
  if (!candidates.length) return "not_offered";
  return candidates.some((variant) => variant.available) ? "available" : "sold_out";
}

export type Selection =
  | { status: "incomplete"; missing: string[] }
  | { status: "unavailable" }
  | { status: "sold_out"; variant: Variant }
  | { status: "ready"; variant: Variant };

/** The variant the shopper's choices identify, or why there is none to buy. */
export function resolveSelection(
  product: Pick<StoreProductResponse, "options" | "variants">,
  chosen: Chosen,
): Selection {
  const options = offeredOptions(product);
  const missing = options.filter((option) => !chosen[option.name]).map((option) => option.name);
  if (missing.length) return { status: "incomplete", missing };
  // Exact match on every offered option; a variant is never picked by "closest". If the choices
  // do not single out one variant (data the options do not describe), none is offered: guessing
  // between them would be a substitution.
  const candidates = product.variants.filter((candidate) =>
    options.every((option) => candidate.attributes[option.name] === chosen[option.name]),
  );
  const variant = candidates.length === 1 ? candidates[0] : undefined;
  if (!variant) return { status: "unavailable" };
  return variant.available ? { status: "ready", variant } : { status: "sold_out", variant };
}

/** "flavour" → "Flavour"; option names are stored lower-case. */
export const optionLabel = (name: string) =>
  name.charAt(0).toUpperCase() + name.slice(1).replaceAll(/[-_]/g, " ");

/** "grape ice · 20 mg" for a variant, in the product's option order. */
export function variantLabel(
  product: Pick<StoreProductResponse, "options">,
  attributes: Readonly<Record<string, string>>,
): string {
  return product.options
    .map((option) => attributes[option.name])
    .filter(Boolean)
    .join(" · ");
}
