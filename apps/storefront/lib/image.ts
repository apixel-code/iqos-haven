import type { StoreImage } from "@ih/contracts";

/** Longest side of each stored derivative (`DERIVATIVE_SIZES` in `@ih/platform`); never enlarged. */
const SIDES = { thumb: 320, medium: 800, large: 1600 } as const;

/**
 * A `srcset` for a stored image (performance, 2026-11-15): the three derivatives with their
 * real widths, worked out from the original size and the longest-side rule, so a phone loads
 * the 800 px copy instead of the 1600 px one. Derivatives that come out the same width (a small
 * original) are listed once.
 */
export function srcSetOf(image: Pick<StoreImage, "width" | "height" | "urls">): string {
  const seen = new Set<number>();
  const entries: string[] = [];
  for (const name of ["thumb", "medium", "large"] as const) {
    const longest = Math.max(image.width, image.height);
    const scale = Math.min(1, SIDES[name] / longest);
    const width = Math.max(1, Math.round(image.width * scale));
    if (seen.has(width)) continue;
    seen.add(width);
    entries.push(`${image.urls[name]} ${width}w`);
  }
  return entries.join(", ");
}
