"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { StoreSearchResponse } from "@ih/contracts";
import { Icon } from "@/components/icons";
import { Dirham } from "@/components/money";
import { ProductGridSkeleton } from "@/components/product-card";
import { Sheet } from "@/components/sheet";
import {
  activeFilterCount,
  bandOf,
  parseSearch,
  PRICE_BANDS,
  PUFF_BANDS,
  SEARCH_SORT_LABELS,
  searchHref,
  type Band,
  type SearchState,
} from "@/lib/store/search";

type Facets = StoreSearchResponse["facets"];
type Fixed = { type?: boolean; brand?: boolean; sale?: boolean };

const TYPE_LABELS = { disposable: "Disposable vapes", kit: "Vape kits & devices" } as const;
const CHIP_TYPES = { disposable: "Disposables", kit: "Vape kits" } as const;

/** "⃃50–100", "Under ⃃50", "⃃200+" (prototype `PRICE` labels with the dirham sign). */
function PriceLabel({ band }: { band: Band }) {
  if (band.min === undefined)
    return (
      <>
        Under <Dirham />
        {band.max}
      </>
    );
  return (
    <>
      <Dirham />
      {band.min}
      {band.max === undefined ? "+" : `–${band.max}`}
    </>
  );
}

const puffCount = (facets: Facets, band: Band) =>
  facets.puffCounts
    .filter(
      (item) =>
        (band.min === undefined || item.puffCount >= band.min) &&
        (band.max === undefined || item.puffCount <= band.max),
    )
    .reduce((sum, item) => sum + item.count, 0);

/** A form's fields as address-bar parameters, read like the address bar. */
function stateOf(form: HTMLFormElement): SearchState {
  const raw: Record<string, string[]> = {};
  for (const [key, value] of new FormData(form))
    if (typeof value === "string" && value !== "") (raw[key] ??= []).push(value);
  return parseSearch(raw);
}

/**
 * The prototype's shop layout (`shop`, ADR 0097): filters beside the products on wide screens,
 * in a bottom sheet behind the Filters button on narrower ones (parity G-S6), the toolbar (count
 * and sort), and removable chips for each active filter. A change applies at once, as in the
 * prototype, by moving to the page's address for it; the grid shows the skeleton meanwhile
 * (parity G-S7). Every form is a plain GET form too, so the page works without JavaScript.
 */
export function ShopLayout({
  path,
  own,
  total,
  facets,
  sorts,
  sort,
  fixed,
  children,
}: {
  /** The page the filters belong to (a listing path or /search). */
  path: string;
  /** What the shopper chose: the only values that go into this page's links. */
  own: SearchState;
  total: number;
  facets: Facets;
  sorts: readonly (keyof typeof SEARCH_SORT_LABELS)[];
  sort: keyof typeof SEARCH_SORT_LABELS;
  fixed: Fixed;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sheet, setSheet] = useState(false);
  const active = activeFilterCount(own);
  const here = searchHref(own, path);
  // The controls are the shopper's own while they change them; an address reached another way
  // (a chip, Back) resets them, so they always show the page's state.
  const [mine, setMine] = useState(here);
  const controls = here === mine ? "mine" : here;
  const go = (next: SearchState) => {
    const target = searchHref({ ...next, cursor: undefined }, path);
    setMine(target);
    startTransition(() => router.push(target, { scroll: false }));
  };
  const apply = (event: FormEvent<HTMLFormElement>) => go(stateOf(event.currentTarget));
  const clear = searchHref({ q: own.q, sort: own.sort }, path);
  const without = (changes: Partial<SearchState>) =>
    searchHref({ ...own, ...changes, cursor: undefined }, path);

  const chips: Array<{ key: string; label: ReactNode; text: string; href: string }> = [];
  if (own.q) chips.push({ key: "q", label: `“${own.q}”`, text: own.q, href: without({ q: "" }) });
  if (own.type)
    chips.push({
      key: "type",
      label: CHIP_TYPES[own.type],
      text: CHIP_TYPES[own.type],
      href: without({ type: undefined }),
    });
  for (const slug of own.brands) {
    const name = facets.brands.find((brand) => brand.slug === slug)?.name ?? slug;
    chips.push({
      key: `brand-${slug}`,
      label: name,
      text: name,
      href: without({ brands: own.brands.filter((item) => item !== slug) }),
    });
  }
  if (own.minPrice !== undefined || own.maxPrice !== undefined) {
    const band = { key: "price", min: own.minPrice, max: own.maxPrice };
    chips.push({
      key: "price",
      label: <PriceLabel band={band} />,
      text: `price ${own.minPrice ?? 0} to ${own.maxPrice ?? "any"} AED`,
      href: without({ minPrice: undefined, maxPrice: undefined }),
    });
  }
  if (own.minPuffs !== undefined || own.maxPuffs !== undefined) {
    const label = `${bandOf(PUFF_BANDS, own.minPuffs, own.maxPuffs)?.label ?? `${(own.minPuffs ?? 0).toLocaleString("en-US")}+`} puffs`;
    chips.push({
      key: "puffs",
      label,
      text: label,
      href: without({ minPuffs: undefined, maxPuffs: undefined }),
    });
  }
  for (const value of own.nicotine)
    chips.push({
      key: `nic-${value}`,
      label: value,
      text: value,
      href: without({ nicotine: own.nicotine.filter((item) => item !== value) }),
    });
  if (own.inStock)
    chips.push({
      key: "stock",
      label: "In stock",
      text: "In stock",
      href: without({ inStock: false }),
    });
  if (own.onSale)
    chips.push({
      key: "sale",
      label: "On sale",
      text: "On sale",
      href: without({ onSale: false }),
    });

  const body = (suffix: "d" | "m") => {
    const id = (name: string, value: string) => `f-${name}-${value || "any"}-${suffix}`;
    const price = bandOf(PRICE_BANDS, own.minPrice, own.maxPrice);
    const puffs = bandOf(PUFF_BANDS, own.minPuffs, own.maxPuffs);
    return (
      <form method="get" action={path} id={`shop-filters-${suffix}`} onChange={apply}>
        {own.q && <input type="hidden" name="q" value={own.q} />}
        {own.sort && <input type="hidden" name="sort" value={own.sort} />}
        {!fixed.type && facets.types.length > 0 && (
          <fieldset className="fgroup">
            <legend>Category</legend>
            <div className="opts">
              {facets.types.map((item) => (
                <label key={item.type} className="check row" htmlFor={id("type", item.type)}>
                  <input
                    type="checkbox"
                    id={id("type", item.type)}
                    name="type"
                    value={item.type}
                    defaultChecked={own.type === item.type}
                  />
                  <span className="ct">{TYPE_LABELS[item.type]}</span>
                  <span className="cn">{item.count}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {!fixed.brand && facets.brands.length > 0 && (
          <fieldset className="fgroup">
            <legend>Brand</legend>
            <div className="opts">
              {facets.brands.map((brand) => (
                <label key={brand.slug} className="check row" htmlFor={id("brand", brand.slug)}>
                  <input
                    type="checkbox"
                    id={id("brand", brand.slug)}
                    name="brand"
                    value={brand.slug}
                    defaultChecked={own.brands.includes(brand.slug)}
                  />
                  <span className="ct">{brand.name}</span>
                  <span className="cn">{brand.count}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="fgroup">
          <legend>Price</legend>
          <div className="opts">
            <label className="check row" htmlFor={id("price", "")}>
              <input
                type="radio"
                id={id("price", "")}
                name="price"
                value=""
                defaultChecked={own.minPrice === undefined && own.maxPrice === undefined}
              />
              <span className="ct">Any price</span>
            </label>
            {PRICE_BANDS.map((band) => (
              <label key={band.key} className="check row" htmlFor={id("price", band.key)}>
                <input
                  type="radio"
                  id={id("price", band.key)}
                  name="price"
                  value={band.key}
                  defaultChecked={price?.key === band.key}
                />
                <span className="ct">
                  <PriceLabel band={band} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {facets.puffCounts.length > 0 && (
          <fieldset className="fgroup">
            <legend>
              Puff count{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                · disposables
              </span>
            </legend>
            <div className="opts">
              <label className="check row" htmlFor={id("puffs", "")}>
                <input
                  type="radio"
                  id={id("puffs", "")}
                  name="puffs"
                  value=""
                  defaultChecked={own.minPuffs === undefined && own.maxPuffs === undefined}
                />
                <span className="ct">Any</span>
              </label>
              {PUFF_BANDS.map((band) => (
                <label key={band.key} className="check row" htmlFor={id("puffs", band.key)}>
                  <input
                    type="radio"
                    id={id("puffs", band.key)}
                    name="puffs"
                    value={band.key}
                    defaultChecked={puffs?.key === band.key}
                  />
                  <span className="ct">{band.label}</span>
                  <span className="cn">{puffCount(facets, band)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {facets.nicotine.length > 0 && (
          <fieldset className="fgroup">
            <legend>Nicotine strength</legend>
            <div className="opts">
              {facets.nicotine.map((item) => (
                <label key={item.value} className="check row" htmlFor={id("nic", item.value)}>
                  <input
                    type="checkbox"
                    id={id("nic", item.value)}
                    name="nicotine"
                    value={item.value}
                    defaultChecked={own.nicotine.includes(item.value)}
                  />
                  <span className="ct">{item.value}</span>
                  <span className="cn">{item.count}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="fgroup" style={{ border: 0 }}>
          <legend>Availability</legend>
          <div className="opts">
            <label className="row" htmlFor={id("stock", "")}>
              <span>In stock only</span>
              <input
                type="checkbox"
                className="switch"
                id={id("stock", "")}
                name="inStock"
                value="true"
                defaultChecked={own.inStock}
              />
            </label>
            {!fixed.sale && (
              <label className="row" htmlFor={id("sale", "")}>
                <span>On sale</span>
                <input
                  type="checkbox"
                  className="switch"
                  id={id("sale", "")}
                  name="onSale"
                  value="true"
                  defaultChecked={own.onSale}
                />
              </label>
            )}
          </div>
        </fieldset>
        <noscript>
          <button type="submit" className="btn btn-primary btn-sm">
            Show results
          </button>
        </noscript>
      </form>
    );
  };

  return (
    <div className="shop-layout">
      <aside className="shop-side" aria-label="Filters">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <h2 className="h3">Filters</h2>
          {active > 0 && (
            <Link href={clear} prefetch={false} className="link small" scroll={false}>
              Clear all
            </Link>
          )}
        </div>
        {/* Keyed by the address, so a back button or chip restores every control. */}
        <div key={`d-${controls}`}>{body("d")}</div>
      </aside>
      <div className="shop-main">
        <div className="toolbar">
          <span className="cnt" aria-live="polite">
            <b>{total}</b> product{total === 1 ? "" : "s"}
          </span>
          {/* `display: contents`: the select lays out as the toolbar's own item. */}
          <form method="get" action={path} key={`sort-${controls}`} style={{ display: "contents" }}>
            {Array.from(new URLSearchParams(searchHref({ ...own, sort: undefined }, "").slice(1)))
              .filter(([key]) => key !== "cursor")
              .map(([key, value], index) => (
                <input key={`${key}-${index}`} type="hidden" name={key} value={value} />
              ))}
            <label className="sr" htmlFor="sort">
              Sort by
            </label>
            <select
              id="sort"
              name="sort"
              className="select sortsel"
              defaultValue={sort}
              onChange={(event) =>
                go({
                  ...own,
                  sort: event.target.value as keyof typeof SEARCH_SORT_LABELS,
                })
              }
            >
              {sorts.map((value) => (
                <option key={value} value={value}>
                  {SEARCH_SORT_LABELS[value]}
                </option>
              ))}
            </select>
            <noscript>
              <button type="submit" className="btn btn-outline btn-sm">
                Sort
              </button>
            </noscript>
          </form>
          <button
            type="button"
            className="fbtn not-lg"
            aria-haspopup="dialog"
            onClick={() => setSheet(true)}
          >
            <Icon name="filter" size="sm" /> Filters{active > 0 && <b>{active}</b>}
          </button>
        </div>
        {chips.length > 0 && (
          <div className="active-chips" aria-label="Active filters">
            {chips.map((chip) => (
              <Link
                key={chip.key}
                href={chip.href}
                prefetch={false}
                scroll={false}
                className="chip chip-x"
                aria-label={`Remove filter ${chip.text}`}
              >
                {chip.label}
                <Icon name="x" />
              </Link>
            ))}
            {chips.length > 1 && (
              <Link
                href={clear}
                prefetch={false}
                scroll={false}
                className="chip"
                style={{ borderColor: "transparent" }}
              >
                Clear all
              </Link>
            )}
          </div>
        )}
        {pending ? <ProductGridSkeleton /> : children}
      </div>
      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Filters"
        className="filters-sheet"
        foot={
          <div style={{ display: "flex", gap: 10 }}>
            {active > 0 && (
              <Link href={clear} prefetch={false} scroll={false} className="btn btn-outline">
                Clear all
              </Link>
            )}
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => setSheet(false)}
            >
              {pending ? "Updating…" : `Show ${total} product${total === 1 ? "" : "s"}`}
            </button>
          </div>
        }
      >
        <div key={`m-${controls}`}>{body("m")}</div>
      </Sheet>
    </div>
  );
}
