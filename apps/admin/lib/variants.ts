import { OPTION_NAMES, type ProductVariantsResponse } from "@ih/contracts";

type OptionName = (typeof OPTION_NAMES)[number];

/** Option values entered one per line or comma separated; stored canonical (lower case). */
export function parseOptionValues(text: string): string[] {
  const values = text
    .split(/[\n,]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}

/** Every combination of the product's options (one empty combination when there are none). */
export function combinations(
  options: ProductVariantsResponse["options"],
): Array<Partial<Record<OptionName, string>>> {
  return options.reduce<Array<Partial<Record<OptionName, string>>>>(
    (acc, option) =>
      acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))),
    [{}],
  );
}

export function signature(attributes: Record<string, string | undefined>) {
  return JSON.stringify(
    Object.keys(attributes)
      .sort()
      .map((key) => [key, attributes[key]]),
  );
}

/** Combinations that have no variant yet, in option order. */
export function missingCombinations(view: ProductVariantsResponse) {
  const existing = new Set(view.variants.map((variant) => signature(variant.attributes)));
  return combinations(view.options).filter((combo) => !existing.has(signature(combo)));
}

/**
 * Suggested SKU from the product slug and option values, with an optional position suffix
 * ("-V01") that keeps batch suggestions distinct even when long slugs or non-Latin values are
 * truncated or stripped. The server checks global uniqueness.
 */
export function suggestSku(
  slug: string,
  attributes: Partial<Record<OptionName, string>>,
  position?: number,
) {
  const clean = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const suffix = position === undefined ? "" : `-V${String(position + 1).padStart(2, "0")}`;
  const values = clean(OPTION_NAMES.map((name) => attributes[name] ?? "").join("-"));
  const room = 64 - suffix.length;
  const slugPart = clean(slug).slice(0, Math.max(8, room - (values ? values.length + 1 : 0)));
  return (
    clean([slugPart, values].filter(Boolean).join("-")).slice(0, room).replace(/-+$/g, "") + suffix
  );
}

export function describeAttributes(attributes: Record<string, string>) {
  const parts = OPTION_NAMES.filter((name) => attributes[name]).map(
    (name) => `${name[0]!.toUpperCase()}${name.slice(1)}: ${attributes[name]}`,
  );
  return parts.length ? parts.join(" · ") : "Single variant (no options)";
}
