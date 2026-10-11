import { z } from "zod";

/**
 * Device lists (roadmap step 63, ADR 0032): saved items, kits to compare and recently viewed
 * products, kept on this device only. Each is a list of product slugs and nothing else: there is
 * no account, no customer profile, and nothing about the shopper. What a list shows (name, price,
 * availability) always comes from the API when it is displayed.
 */
export const LISTS_STORAGE_KEY = "ih_lists_v1";
export const LIST_LIMITS = { saved: 100, compare: 3, recent: 12 } as const;

const slug = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const listsSchema = z.strictObject({
  v: z.literal(1),
  saved: z.array(slug).max(LIST_LIMITS.saved),
  compare: z.array(slug).max(LIST_LIMITS.compare),
  recent: z.array(slug).max(LIST_LIMITS.recent),
});
export type DeviceLists = z.infer<typeof listsSchema>;
export const EMPTY_LISTS: DeviceLists = { v: 1, saved: [], compare: [], recent: [] };

const unique = (items: readonly string[]) => [...new Set(items)];

/** Reads stored text; anything unreadable or off-schema is empty lists, never an error. */
export function parseLists(text: string | null): DeviceLists {
  if (!text) return EMPTY_LISTS;
  try {
    const parsed = listsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return EMPTY_LISTS;
    const { saved, compare, recent } = parsed.data;
    return { v: 1, saved: unique(saved), compare: unique(compare), recent: unique(recent) };
  } catch {
    return EMPTY_LISTS;
  }
}

const valid = (value: string) => slug.safeParse(value).success;

/** Saves or unsaves a product. A full list refuses a new item and says so. */
export function toggleSaved(
  lists: DeviceLists,
  productSlug: string,
): { lists: DeviceLists; saved: boolean; full: boolean } {
  if (lists.saved.includes(productSlug))
    return {
      lists: { ...lists, saved: lists.saved.filter((item) => item !== productSlug) },
      saved: false,
      full: false,
    };
  if (!valid(productSlug)) return { lists, saved: false, full: false };
  if (lists.saved.length >= LIST_LIMITS.saved) return { lists, saved: false, full: true };
  // Newest first.
  return { lists: { ...lists, saved: [productSlug, ...lists.saved] }, saved: true, full: false };
}

/** Adds or removes a kit from the comparison (at most three). */
export function toggleCompare(
  lists: DeviceLists,
  productSlug: string,
): { lists: DeviceLists; comparing: boolean; full: boolean } {
  if (lists.compare.includes(productSlug))
    return {
      lists: { ...lists, compare: lists.compare.filter((item) => item !== productSlug) },
      comparing: false,
      full: false,
    };
  if (!valid(productSlug)) return { lists, comparing: false, full: false };
  if (lists.compare.length >= LIST_LIMITS.compare) return { lists, comparing: false, full: true };
  return {
    lists: { ...lists, compare: [...lists.compare, productSlug] },
    comparing: true,
    full: false,
  };
}

/** Puts a product at the front of recently viewed; the oldest drops off the end. */
export function recordView(lists: DeviceLists, productSlug: string): DeviceLists {
  if (!valid(productSlug) || lists.recent[0] === productSlug) return lists;
  return {
    ...lists,
    recent: [productSlug, ...lists.recent.filter((item) => item !== productSlug)].slice(
      0,
      LIST_LIMITS.recent,
    ),
  };
}

/** Removes a slug from one list (an item that is no longer available, or a "Remove" press). */
export function removeFrom(
  lists: DeviceLists,
  list: "saved" | "compare" | "recent",
  productSlug: string,
): DeviceLists {
  if (!lists[list].includes(productSlug)) return lists;
  return { ...lists, [list]: lists[list].filter((item) => item !== productSlug) };
}

/**
 * After a rename the API answers an old slug with the current one: store the current slug so the
 * list keeps working when the old one is retired. Order and limits are preserved.
 */
export function renameIn(lists: DeviceLists, renames: ReadonlyMap<string, string>): DeviceLists {
  if (![...renames].some(([from, to]) => from !== to)) return lists;
  const apply = (items: readonly string[]) =>
    unique(items.map((item) => (valid(renames.get(item) ?? "") ? renames.get(item)! : item)));
  const next = {
    v: 1 as const,
    saved: apply(lists.saved),
    compare: apply(lists.compare),
    recent: apply(lists.recent),
  };
  return JSON.stringify(next) === JSON.stringify(lists) ? lists : next;
}
