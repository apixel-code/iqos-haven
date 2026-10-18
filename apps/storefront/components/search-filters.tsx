import type { StoreSearchResponse } from "@ih/contracts";
import { displayAed } from "@/lib/store/listing";
import { SEARCH_SORT_LABELS, type SearchState } from "@/lib/store/search";

const group = "flex flex-col gap-2 border-t border-line pt-4 first:border-t-0 first:pt-0";
const legend = "text-xs font-semibold uppercase tracking-[0.08em] text-ink-2";
const option = "flex items-center justify-between gap-3 text-sm";
const count = "font-mono text-xs text-ink-3";
const field =
  "h-10 w-full rounded-sm border-[1.5px] border-line bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * Filter form for the search page: a plain GET form, so it works without JavaScript. Each
 * number beside a choice is how many products choosing it would give with the other filters
 * kept (the API's facet rule). Submitting restarts at the first page.
 */
export function SearchFilters({
  state,
  result,
  action = "/search",
  fixed = {},
}: {
  state: SearchState;
  result: StoreSearchResponse;
  /** The page the form submits to: the search page, or a listing page (parity G-S2). */
  action?: string;
  /** Filters a listing page fixes in its path: not offered as choices. */
  fixed?: { type?: boolean; brand?: boolean; sale?: boolean };
}) {
  const { facets } = result;
  const typeLabels = { disposable: "Disposable vapes", kit: "Vape kits & devices" } as const;
  const sorts = (Object.keys(SEARCH_SORT_LABELS) as Array<keyof typeof SEARCH_SORT_LABELS>).filter(
    (sort) => sort !== "relevance" || result.query !== "",
  );
  return (
    <form method="get" action={action} className="flex flex-col gap-4">
      {state.q && <input type="hidden" name="q" value={state.q} />}
      <fieldset className={group}>
        <legend className={legend}>Sort by</legend>
        <select name="sort" defaultValue={result.sort} aria-label="Sort by" className={field}>
          {sorts.map((sort) => (
            <option key={sort} value={sort}>
              {SEARCH_SORT_LABELS[sort]}
            </option>
          ))}
        </select>
      </fieldset>
      {!fixed.type && facets.types.length > 0 && (
        <fieldset className={group}>
          <legend className={legend}>Category</legend>
          <label className={option}>
            <span className="flex items-center gap-2">
              <input type="radio" name="type" value="" defaultChecked={!state.type} /> All
            </span>
          </label>
          {facets.types.map((item) => (
            <label key={item.type} className={option}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="type"
                  value={item.type}
                  defaultChecked={state.type === item.type}
                />
                {typeLabels[item.type]}
              </span>
              <span className={count}>{item.count}</span>
            </label>
          ))}
        </fieldset>
      )}
      {!fixed.brand && facets.brands.length > 0 && (
        <fieldset className={group}>
          <legend className={legend}>Brand</legend>
          {facets.brands.map((brand) => (
            <label key={brand.slug} className={option}>
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="brand"
                  value={brand.slug}
                  defaultChecked={state.brands.includes(brand.slug)}
                />
                {brand.name}
              </span>
              <span className={count}>{brand.count}</span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className={group}>
        <legend className={legend}>Price (AED)</legend>
        <div className="flex items-center gap-2">
          <input
            name="minPrice"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={8}
            placeholder="Min"
            aria-label="Minimum price in dirhams"
            defaultValue={state.minPrice ?? ""}
            className={field}
          />
          <span aria-hidden="true">–</span>
          <input
            name="maxPrice"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={8}
            placeholder="Max"
            aria-label="Maximum price in dirhams"
            defaultValue={state.maxPrice ?? ""}
            className={field}
          />
        </div>
        {facets.price && (
          <p className="text-xs text-ink-3">
            {displayAed(facets.price.minFils)} to {displayAed(facets.price.maxFils)}
          </p>
        )}
      </fieldset>
      {facets.puffCounts.length > 0 && (
        <fieldset className={group}>
          <legend className={legend}>Puff count · disposables</legend>
          <label className={option}>
            <span className="flex items-center gap-2">
              <input type="radio" name="minPuffs" value="" defaultChecked={!state.minPuffs} /> Any
            </span>
          </label>
          {facets.puffCounts.map((item) => (
            <label key={item.puffCount} className={option}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="minPuffs"
                  value={item.puffCount}
                  defaultChecked={state.minPuffs === item.puffCount}
                />
                {item.puffCount.toLocaleString("en-US")} or more
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {facets.nicotine.length > 0 && (
        <fieldset className={group}>
          <legend className={legend}>Nicotine strength</legend>
          {facets.nicotine.map((item) => (
            <label key={item.value} className={option}>
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="nicotine"
                  value={item.value}
                  defaultChecked={state.nicotine.includes(item.value)}
                />
                {item.value}
              </span>
              <span className={count}>{item.count}</span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className={group}>
        <legend className={legend}>Availability</legend>
        <label className={option}>
          <span className="flex items-center gap-2">
            <input type="checkbox" name="inStock" value="true" defaultChecked={state.inStock} />
            In stock only
          </span>
          <span className={count}>{facets.inStock}</span>
        </label>
        {!fixed.sale && (
          <label className={option}>
            <span className="flex items-center gap-2">
              <input type="checkbox" name="onSale" value="true" defaultChecked={state.onSale} />
              On sale
            </span>
            <span className={count}>{facets.onSale}</span>
          </label>
        )}
      </fieldset>
      <button
        type="submit"
        className="h-10 rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Show results
      </button>
    </form>
  );
}
