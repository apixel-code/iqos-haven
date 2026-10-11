"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { storeSuggestResponseSchema, type StoreSuggestResponse } from "@ih/contracts";

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
  // Remembered with the term they answer, so stale ones are simply not shown.
  const [answer, setAnswer] = useState<{ term: string; data: StoreSuggestResponse } | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const latest = useRef(0);

  useEffect(() => {
    const term = value.trim();
    if (term.length < 2) return;
    const request = ++latest.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v1/store/search/suggest?q=${encodeURIComponent(term.slice(0, 200))}`, {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          const parsed = storeSuggestResponseSchema.safeParse(body);
          // Ignore answers to an older keystroke and anything off-contract.
          if (request === latest.current && parsed.success) setAnswer({ term, data: parsed.data });
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  const suggestions = answer !== null && answer.term === value.trim() ? answer.data : null;
  const hasSuggestions =
    open && suggestions !== null && suggestions.products.length + suggestions.brands.length > 0;
  return (
    <form
      method="get"
      action="/search"
      role="search"
      className="relative w-full sm:max-w-xs"
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
      <div className="flex gap-2">
        <input
          id={`${listId}-input`}
          type="search"
          name="q"
          value={value}
          maxLength={200}
          autoComplete="off"
          placeholder="Search brands, flavours, puffs"
          aria-controls={hasSuggestions ? listId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="h-10 min-w-0 flex-1 rounded-pill border-[1.5px] border-line bg-surface px-4 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <button
          type="submit"
          className="h-10 rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Search
        </button>
      </div>
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
