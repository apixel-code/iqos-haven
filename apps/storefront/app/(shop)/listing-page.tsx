import type { ReactNode } from "react";
import { Breadcrumbs, EmptyState, PageHead, type Crumb } from "@/components/listing";
import { PendingLink } from "@/components/pending";
import { ProductGrid } from "@/components/product-card";
import { SearchFilters } from "@/components/search-filters";
import type { ProductType } from "@/lib/store/listing";
import {
  activeFilterCount,
  parseSearch,
  searchApiParams,
  searchHref,
  type SearchState,
} from "@/lib/store/search";
import { restartOnStaleCursor, storeRead } from "@/lib/store/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Fixed = { type?: ProductType; brand?: string; category?: string; sale?: true };

const link =
  "inline-flex h-10 items-center rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * One implementation for every product listing, with the same filters as search (parity G-S2,
 * ADR 0086): price, puff count, nicotine, stock and sale, each with its count. A page fixes some
 * filters in its path (`fixed`); they always win over the address bar, are not offered as
 * choices and never appear in the page's own links. Browsing has no search term, so the API
 * answers it from the catalogue cache under the catalogue's request budget.
 */
export async function ListingPage({
  path,
  searchParams,
  fixed = {},
  trail,
  head,
  emptyBody,
}: {
  path: string;
  searchParams: SearchParams;
  fixed?: Fixed;
  trail: readonly Crumb[];
  head: ReactNode | { title: string; lead?: string };
  emptyBody: string;
}) {
  const chosen = parseSearch(await searchParams);
  // What the shopper chose: no term on a listing, no category from the address bar, and nothing
  // the page fixes. These are the only values that go into this page's links.
  const own: SearchState = {
    ...chosen,
    q: "",
    category: undefined,
    type: fixed.type ? undefined : chosen.type,
    brands: fixed.brand ? [] : chosen.brands,
    onSale: fixed.sale ? false : chosen.onSale,
    sort: chosen.sort === "relevance" ? undefined : chosen.sort,
  };
  const state: SearchState = {
    ...own,
    ...(fixed.type ? { type: fixed.type } : {}),
    ...(fixed.brand ? { brands: [fixed.brand] } : {}),
    ...(fixed.category ? { category: fixed.category } : {}),
    ...(fixed.sale ? { onSale: true } : {}),
  };
  const href = (changes: Partial<SearchState>) => searchHref({ ...own, ...changes }, path);
  const result = await restartOnStaleCursor(
    () => storeRead((api, shopper) => api.search(shopper, searchApiParams(state))),
    Boolean(state.cursor),
    href({ cursor: undefined }),
  );
  const filters = activeFilterCount(own);
  const panel = (
    <SearchFilters
      state={state}
      result={result}
      action={path}
      fixed={{ type: Boolean(fixed.type), brand: Boolean(fixed.brand), sale: fixed.sale }}
    />
  );
  return (
    <>
      <Breadcrumbs trail={trail} />
      {head && typeof head === "object" && "title" in head ? <PageHead {...head} /> : head}
      <div className="grid gap-9 lg:grid-cols-[250px_1fr]">
        <aside aria-label="Filters">
          <details
            className="rounded-md border border-line bg-surface p-4 lg:hidden"
            open={filters > 0}
          >
            <summary className="cursor-pointer text-sm font-semibold">
              Filters{filters > 0 ? ` (${filters})` : ""}
            </summary>
            <div className="pt-4">{panel}</div>
          </details>
          <div className="hidden flex-col gap-4 lg:flex">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Filters</h2>
              {filters > 0 && (
                <PendingLink href={path} className="text-sm underline">
                  Clear all
                </PendingLink>
              )}
            </div>
            {panel}
          </div>
        </aside>
        <section aria-label="Products" className="flex flex-col gap-6">
          {result.total === 0 ? (
            filters > 0 ? (
              <EmptyState
                title="No products match these filters"
                body="Try removing a filter or widening the price range."
                action={{ href: path, label: "Clear all filters" }}
              />
            ) : (
              <EmptyState title="Nothing here yet" body={emptyBody} />
            )
          ) : (
            <>
              <p aria-live="polite" className="text-sm text-ink-2">
                <b className="font-semibold text-ink">{result.total}</b>{" "}
                {result.total === 1 ? "product" : "products"}
              </p>
              {result.items.length === 0 ? (
                <EmptyState
                  title="No more products"
                  body="You have reached the end of this list."
                  action={{ href: href({ cursor: undefined }), label: "Back to the start" }}
                />
              ) : (
                <ProductGrid products={result.items} />
              )}
              {(state.cursor || result.nextCursor) && (
                <nav aria-label="Pages" className="flex flex-wrap justify-center gap-3 pt-2">
                  {state.cursor && (
                    <PendingLink href={href({ cursor: undefined })} className={link}>
                      Back to the start
                    </PendingLink>
                  )}
                  {result.nextCursor && (
                    <PendingLink
                      href={href({ cursor: result.nextCursor })}
                      rel="next"
                      className={link}
                    >
                      Next page
                    </PendingLink>
                  )}
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
