import type { Metadata } from "next";
import { Breadcrumbs, EmptyState, PageHead } from "@/components/listing";
import { PendingLink } from "@/components/pending";
import { ProductGrid } from "@/components/product-card";
import { SearchFilters } from "@/components/search-filters";
import { SITE } from "@/lib/site";
import { activeFilterCount, parseSearch, searchApiParams, searchHref } from "@/lib/store/search";
import { restartOnStaleCursor, storeRead } from "@/lib/store/server";

// The search term never goes into the title: titles are generic until a result is opened.
export const metadata: Metadata = { title: `Search · ${SITE.name}` };

const link =
  "inline-flex h-10 items-center rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Search and filtered browsing (prototype shop view with a query). */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = parseSearch(await searchParams);
  const result = await restartOnStaleCursor(
    () => storeRead((api, shopper) => api.search(shopper, searchApiParams(state))),
    Boolean(state.cursor),
    searchHref({ ...state, cursor: undefined }),
  );
  const filters = activeFilterCount(state);
  const term = result.query;
  const title = term ? `Results for “${term}”` : "Search";
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Search" }]} />
      <PageHead
        title={title}
        lead={term ? undefined : "Search by brand, flavour or puff count, or filter the catalogue."}
      />
      <div className="grid gap-9 lg:grid-cols-[250px_1fr]">
        <aside aria-label="Filters">
          <details
            className="rounded-md border border-line bg-surface p-4 lg:hidden"
            open={filters > 0}
          >
            <summary className="cursor-pointer text-sm font-semibold">
              Filters{filters > 0 ? ` (${filters})` : ""}
            </summary>
            <div className="pt-4">
              <SearchFilters state={state} result={result} />
            </div>
          </details>
          <div className="hidden flex-col gap-4 lg:flex">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Filters</h2>
              {filters > 0 && (
                <PendingLink href={searchHref({ q: state.q })} className="text-sm underline">
                  Clear all
                </PendingLink>
              )}
            </div>
            <SearchFilters state={state} result={result} />
          </div>
        </aside>
        <section aria-label="Results" className="flex flex-col gap-6">
          {result.approximate && result.total > 0 && (
            <p role="status" className="rounded-md bg-accent-soft px-4 py-3 text-sm">
              Nothing matched “{term}” exactly. Showing similar results.
            </p>
          )}
          {result.total === 0 ? (
            term ? (
              <EmptyState
                title={`No results for “${term}”`}
                body={
                  filters > 0
                    ? "Try removing a filter, or check the spelling."
                    : "Check the spelling, or try a brand, flavour or puff count."
                }
                action={
                  filters > 0
                    ? { href: searchHref({ q: state.q }), label: "Clear all filters" }
                    : { href: "/shop", label: "Browse all products" }
                }
              />
            ) : (
              <EmptyState
                title="No products match these filters"
                body="Try removing a filter or widening the price range."
                action={{ href: "/search", label: "Clear all filters" }}
              />
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
                  body="You have reached the end of these results."
                  action={{
                    href: searchHref({ ...state, cursor: undefined }),
                    label: "Back to the start",
                  }}
                />
              ) : (
                <ProductGrid products={result.items} />
              )}
              {(state.cursor || result.nextCursor) && (
                <nav aria-label="Pages" className="flex flex-wrap justify-center gap-3 pt-2">
                  {state.cursor && (
                    <PendingLink
                      href={searchHref({ ...state, cursor: undefined })}
                      className={link}
                    >
                      Back to the start
                    </PendingLink>
                  )}
                  {result.nextCursor && (
                    <PendingLink
                      href={searchHref({ ...state, cursor: result.nextCursor })}
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
