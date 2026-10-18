"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import { useSuggestions } from "@/lib/store/client-hooks";

/**
 * Search field (plain GET form to /search, so it works without JavaScript) with suggestions
 * while typing. Suggestions come from the same-origin API route, which checks the age ticket
 * itself; if they cannot be loaded the field simply has none.
 */
export function SearchBox() {
  const pathname = usePathname();
  const params = useSearchParams();
  // On the results page the field shows what was searched.
  const [value, setValue] = useState(pathname === "/search" ? (params.get("q") ?? "") : "");
  const [open, setOpen] = useState(false);
  const listId = useId();
  const suggestions = useSuggestions(value);
  const hasSuggestions =
    open && suggestions !== null && suggestions.products.length + suggestions.brands.length > 0;
  return (
    <form
      method="get"
      action="/search"
      role="search"
      // The prototype's header search bar (wide screens; phones use the search sheet).
      className="searchbar only-lg relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <label className="sr-only" htmlFor={`${listId}-input`}>
        Search products
      </label>
      <Icon name="search" />
      <input
        id={`${listId}-input`}
        type="search"
        name="q"
        value={value}
        maxLength={200}
        autoComplete="off"
        placeholder="Search vapes, brands, flavours"
        aria-controls={hasSuggestions ? listId : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      <button type="submit" className="sr">
        Search
      </button>
      {hasSuggestions && (
        <div
          id={listId}
          className="absolute left-0 right-0 top-12 z-10 flex flex-col gap-2 rounded-md border border-line bg-surface p-3 text-sm shadow-3"
        >
          {suggestions.brands.length > 0 && (
            <ul aria-label="Brands" className="flex flex-wrap gap-2">
              {suggestions.brands.map((brand) => (
                <li key={brand.slug}>
                  <a
                    href={`/brands/${brand.slug}`}
                    className="inline-flex h-8 items-center rounded-pill bg-surface-2 px-3 text-xs font-medium hover:bg-line"
                  >
                    {brand.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <ul aria-label="Products" className="flex flex-col">
            {suggestions.products.map((product) => (
              <li key={product.slug}>
                <a
                  href={`/p/${product.slug}`}
                  className="flex flex-col rounded-sm px-2 py-1.5 hover:bg-surface-2"
                >
                  <span className="font-medium">{product.name}</span>
                  <span className="text-xs text-ink-3">{product.brandName}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
