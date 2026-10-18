import type { ReactNode } from "react";
import { Breadcrumbs, EmptyState, PageHead, type Crumb } from "@/components/listing";
import { PendingLink } from "@/components/pending";
import { ProductGrid } from "@/components/product-card";
import { ShopLayout } from "@/components/shop-layout";
import { TrackSearch } from "@/components/track-search";
import { SITE } from "@/lib/site";
import type { ProductType } from "@/lib/store/listing";
import {
  activeFilterCount,
  parseSearch,
  SEARCH_SORT_LABELS,
  searchApiParams,
  searchHref,
  type SearchState,
} from "@/lib/store/search";
import { restartOnStaleCursor, storeInfo, storeRead } from "@/lib/store/server";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Fixed = { type?: ProductType; brand?: string; category?: string; sale?: true };

/**
 * One implementation for every product listing and for search (parity G-S2, ADR 0086; the
 * prototype's `shop` since ADR 0097). A page fixes some filters in its path (`fixed`); they
 * always win over the address bar, are not offered as choices and never appear in the page's own
 * links. Browsing has no term, so the API answers it from the catalogue cache under the
 * catalogue's request budget; `/search` keeps the shopper's term.
 */
export async function ListingPage({
  path,
  searchParams,
  fixed = {},
  trail,
  head,
  emptyBody,
  search = false,
}: {
  path: string;
  searchParams: SearchParams;
  fixed?: Fixed;
  trail: readonly Crumb[];
  /** The page heading; on /search it is worked out from the term. */
  head?: ReactNode | { title: string; lead?: string };
  emptyBody: string;
  /** The search page: keeps the term, counts the search, offers WhatsApp on no results. */
  search?: boolean;
}) {
  const chosen = parseSearch(await searchParams);
  // What the shopper chose: no term on a listing, no category from the address bar, and nothing
  // the page fixes. These are the only values that go into this page's links.
  const own: SearchState = {
    ...chosen,
    q: search ? chosen.q : "",
    category: undefined,
    type: fixed.type ? undefined : chosen.type,
    brands: fixed.brand ? [] : chosen.brands,
    onSale: fixed.sale ? false : chosen.onSale,
    sort: !search && chosen.sort === "relevance" ? undefined : chosen.sort,
  };
  const state: SearchState = {
    ...own,
    ...(fixed.type ? { type: fixed.type } : {}),
    ...(fixed.brand ? { brands: [fixed.brand] } : {}),
    ...(fixed.category ? { category: fixed.category } : {}),
    ...(fixed.sale ? { onSale: true } : {}),
  };
  const href = (changes: Partial<SearchState>) => searchHref({ ...own, ...changes }, path);
  const [result, { whatsappNumber }] = await Promise.all([
    restartOnStaleCursor(
      () => storeRead((api, shopper) => api.search(shopper, searchApiParams(state))),
      Boolean(state.cursor),
      href({ cursor: undefined }),
    ),
    storeInfo(),
  ]);
  const filters = activeFilterCount(own);
  const term = search ? result.query : "";
  const sorts = (Object.keys(SEARCH_SORT_LABELS) as Array<keyof typeof SEARCH_SORT_LABELS>).filter(
    (sort) => sort !== "relevance" || term !== "",
  );
  const ask = term ? whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.search(SITE.name, term)) : null;
  const heading = search
    ? {
        title: term ? `Results for “${term}”` : "Search",
        lead: term ? undefined : "Search by brand, flavour or puff count, or filter the catalogue.",
      }
    : head;
  return (
    <>
      {/* Counted once per search: the first page only, not when paging through results. */}
      {term && !state.cursor && <TrackSearch term={term} total={result.total} />}
      <Breadcrumbs trail={trail} />
      {heading && typeof heading === "object" && "title" in heading ? (
        <PageHead {...heading} />
      ) : (
        heading
      )}
      <ShopLayout
        path={path}
        own={own}
        total={result.total}
        facets={result.facets}
        sorts={sorts}
        sort={result.sort}
        fixed={{ type: Boolean(fixed.type), brand: Boolean(fixed.brand), sale: fixed.sale }}
      >
        {result.approximate && result.total > 0 && (
          <p role="status" className="note" style={{ marginBottom: 18 }}>
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
                  ? { href: searchHref({ q: own.q }, path), label: "Clear all filters" }
                  : { href: "/shop", label: "Browse all products" }
              }
            >
              {/* Parity G-S9: ask the shop for what the catalogue does not show. */}
              {ask && (
                <p className="small" style={{ marginTop: 6 }}>
                  Can&apos;t find it?{" "}
                  <a href={ask} target="_blank" rel="noopener noreferrer" className="link">
                    Ask us on WhatsApp
                  </a>
                </p>
              )}
            </EmptyState>
          ) : filters > 0 ? (
            <EmptyState
              title="No products match these filters"
              body="Try removing a filter or widening the price range."
              action={{ href: searchHref({ q: own.q }, path), label: "Clear all filters" }}
            />
          ) : (
            <EmptyState title="Nothing here yet" body={emptyBody} />
          )
        ) : result.items.length === 0 ? (
          <EmptyState
            title="No more products"
            body="You have reached the end of this list."
            action={{ href: href({ cursor: undefined }), label: "Back to the start" }}
          />
        ) : (
          <>
            <ProductGrid products={result.items} />
            {(state.cursor || result.nextCursor) && (
              <nav
                aria-label="Pages"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: 12,
                  marginTop: 32,
                }}
              >
                {state.cursor && (
                  <PendingLink href={href({ cursor: undefined })} className="btn btn-outline">
                    Back to the start
                  </PendingLink>
                )}
                {result.nextCursor && (
                  <PendingLink
                    href={href({ cursor: result.nextCursor })}
                    rel="next"
                    className="btn btn-outline"
                  >
                    Next page
                  </PendingLink>
                )}
              </nav>
            )}
          </>
        )}
      </ShopLayout>
    </>
  );
}
