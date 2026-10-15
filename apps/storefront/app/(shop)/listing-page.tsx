import type { ReactNode } from "react";
import { Breadcrumbs, PageHead, ProductListing, type Crumb } from "@/components/listing";
import { ListingControls } from "@/components/sort-form";
import { listingHref, parseListing, type ProductType } from "@/lib/store/listing";
import { restartOnStaleCursor, storeRead } from "@/lib/store/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One implementation for every product listing. A page fixes some filters (`fixed`) and lets
 * the shopper choose the rest; the fixed ones always win over the address bar.
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
  fixed?: { type?: ProductType; brand?: string; category?: string; sale?: true };
  trail: readonly Crumb[];
  head: ReactNode | { title: string; lead?: string };
  emptyBody: string;
}) {
  const chosen = parseListing(await searchParams);
  const state = {
    ...chosen,
    ...(fixed.type ? { type: fixed.type } : {}),
    ...(fixed.brand ? { brand: fixed.brand } : {}),
  };
  const offerBrands = !fixed.brand;
  const [page, brands] = await restartOnStaleCursor(
    () =>
      storeRead((api, shopper) =>
        Promise.all([
          api.products(shopper, {
            brand: state.brand,
            type: state.type,
            category: fixed.category,
            ...(fixed.sale ? { sale: "1" as const } : {}),
            sort: state.sort,
            cursor: state.cursor,
          }),
          offerBrands ? api.brands(shopper) : Promise.resolve(null),
        ]),
      ),
    Boolean(state.cursor),
    listingHref(path, {
      sort: state.sort,
      ...(fixed.type ? {} : { type: state.type }),
      ...(fixed.brand ? {} : { brand: state.brand }),
    }),
  );
  const filtered = Boolean((!fixed.type && state.type) || (!fixed.brand && state.brand));
  return (
    <>
      <Breadcrumbs trail={trail} />
      {head && typeof head === "object" && "title" in head ? <PageHead {...head} /> : head}
      <ProductListing
        path={path}
        // Fixed filters live in the path, so they are never repeated in links.
        state={{
          sort: state.sort,
          cursor: state.cursor,
          ...(fixed.type ? {} : { type: state.type }),
          ...(fixed.brand ? {} : { brand: state.brand }),
        }}
        page={page}
        controls={
          <ListingControls
            action={path}
            sort={state.sort}
            type={state.type}
            brand={state.brand}
            showType={!fixed.type}
            brands={brands?.items
              .filter((item) => item.productCount > 0)
              .map((item) => ({ slug: item.slug, name: item.name }))}
          />
        }
        empty={
          filtered
            ? {
                title: "No products match these filters",
                body: "Try removing a filter.",
                action: { href: path, label: "Clear all filters" },
              }
            : { title: "Nothing here yet", body: emptyBody }
        }
      />
    </>
  );
}
