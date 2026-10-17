import { STORE_SEARCH_SORTS, type StoreSearchSort } from "@ih/contracts";
import type { ProductType } from "./listing";

/**
 * Search page state from the address bar (roadmap step 60). As on the listing pages, only known
 * and well-formed values survive; they are the only things sent to the API. Prices are typed in
 * whole dirhams and converted to integer fils here.
 */
export const SEARCH_SORT_LABELS: Record<StoreSearchSort, string> = {
  relevance: "Best match",
  newest: "Newest",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  name: "Name: A to Z",
};

export interface SearchState {
  q: string;
  type?: ProductType;
  brands: string[];
  /** A category page's fixed scope (parity G-S2); never typed by the shopper. */
  category?: string;
  /** Whole dirhams, as typed. */
  minPrice?: number;
  maxPrice?: number;
  minPuffs?: number;
  nicotine: string[];
  inStock: boolean;
  onSale: boolean;
  sort?: StoreSearchSort;
  cursor?: string;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const MAX_AED = 10_000_000;
type RawParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const many = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function wholeNumber(value: string | undefined, max: number): number | undefined {
  if (!value || !/^\d{1,9}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 0 && number <= max ? number : undefined;
}

export function parseSearch(raw: RawParams): SearchState {
  const type = first(raw.type);
  const sort = first(raw.sort);
  const cursor = first(raw.cursor);
  const minPrice = wholeNumber(first(raw.minPrice), MAX_AED);
  const maxPrice = wholeNumber(first(raw.maxPrice), MAX_AED);
  const minPuffs = wholeNumber(first(raw.minPuffs), 1_000_000);
  // A range typed the wrong way round is ignored rather than sent as an error.
  const validRange = minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice;
  return {
    q: (first(raw.q) ?? "").slice(0, 200).trim(),
    ...(type === "disposable" || type === "kit" ? { type } : {}),
    ...(first(raw.category) && SLUG.test(first(raw.category)!) && first(raw.category)!.length <= 150
      ? { category: first(raw.category)! }
      : {}),
    brands: [...new Set(many(raw.brand))]
      .filter((slug) => slug.length <= 150 && SLUG.test(slug))
      .slice(0, 10),
    ...(validRange && minPrice !== undefined ? { minPrice } : {}),
    ...(validRange && maxPrice !== undefined ? { maxPrice } : {}),
    ...(minPuffs ? { minPuffs } : {}),
    nicotine: [...new Set(many(raw.nicotine).map((value) => value.trim()))]
      .filter((value) => value.length >= 1 && value.length <= 40)
      .slice(0, 6),
    inStock: first(raw.inStock) === "true",
    onSale: first(raw.onSale) === "true",
    ...((STORE_SEARCH_SORTS as readonly string[]).includes(sort ?? "")
      ? { sort: sort as StoreSearchSort }
      : {}),
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
  };
}

/** The API query for a state, as ordered key/value pairs. */
export function searchApiParams(state: SearchState, limit?: number): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  if (state.q) params.push(["q", state.q]);
  if (state.type) params.push(["type", state.type]);
  for (const brand of state.brands) params.push(["brand", brand]);
  if (state.category) params.push(["category", state.category]);
  if (state.minPrice !== undefined) params.push(["minPriceFils", String(state.minPrice * 100)]);
  if (state.maxPrice !== undefined) params.push(["maxPriceFils", String(state.maxPrice * 100)]);
  if (state.minPuffs !== undefined) params.push(["minPuffs", String(state.minPuffs)]);
  for (const value of state.nicotine) params.push(["nicotine", value]);
  if (state.inStock) params.push(["inStock", "true"]);
  if (state.onSale) params.push(["onSale", "true"]);
  if (state.sort) params.push(["sort", state.sort]);
  if (limit !== undefined) params.push(["limit", String(limit)]);
  if (state.cursor) params.push(["cursor", state.cursor]);
  return params;
}

/**
 * A link to the search page, or to a listing page (`path`), for a state (page-level names:
 * prices stay in dirhams).
 */
export function searchHref(state: Partial<SearchState>, path = "/search"): string {
  const query = new URLSearchParams();
  if (state.q) query.set("q", state.q);
  if (state.type) query.set("type", state.type);
  for (const brand of state.brands ?? []) query.append("brand", brand);
  if (state.category) query.set("category", state.category);
  if (state.minPrice !== undefined) query.set("minPrice", String(state.minPrice));
  if (state.maxPrice !== undefined) query.set("maxPrice", String(state.maxPrice));
  if (state.minPuffs !== undefined) query.set("minPuffs", String(state.minPuffs));
  for (const value of state.nicotine ?? []) query.append("nicotine", value);
  if (state.inStock) query.set("inStock", "true");
  if (state.onSale) query.set("onSale", "true");
  if (state.sort) query.set("sort", state.sort);
  if (state.cursor) query.set("cursor", state.cursor);
  return query.size ? `${path}?${query}` : path;
}

/** How many filters (not the term or the sort) are active. */
export function activeFilterCount(state: SearchState): number {
  return (
    (state.type ? 1 : 0) +
    state.brands.length +
    (state.minPrice !== undefined || state.maxPrice !== undefined ? 1 : 0) +
    (state.minPuffs !== undefined ? 1 : 0) +
    state.nicotine.length +
    (state.inStock ? 1 : 0) +
    (state.onSale ? 1 : 0)
  );
}
