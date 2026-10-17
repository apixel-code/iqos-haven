"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { useStoreBrands, useSuggestions } from "@/lib/store/client-hooks";
import { displayAed } from "@/lib/store/listing";

const chip =
  "inline-flex h-9 items-center rounded-pill border border-line bg-surface px-3 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const heading = "text-xs font-semibold uppercase tracking-[0.08em] text-ink-2";
const row =
  "flex min-h-12 flex-col justify-center rounded-sm px-2 py-1.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * Mobile search (parity G-S3, ADR 0087): a full-screen sheet from the top, opened from the
 * header below the `md` breakpoint (wider screens keep the inline search box). Before typing
 * it offers the brands and the products recently viewed on this device; while typing, the
 * suggested brands and products and a link to every result. It is the same plain GET form to
 * /search, so Enter always searches. Brands load when the sheet first opens.
 */
export function SearchSheet() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const pathname = usePathname();
  const close = () => dialog.current?.close();
  // A followed link closes the sheet, including Back and Forward.
  useEffect(() => close(), [pathname]);
  const { brands, load: loadBrands, ensure: ensureBrands } = useStoreBrands();

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
          ensureBrands();
        }}
        className="inline-flex h-10 items-center rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:hidden"
      >
        Search
      </button>
      <dialog
        ref={dialog}
        aria-label="Search"
        // The close event arrives after the dialog closed; it may have been reopened since.
        onClose={() => !dialog.current?.open && setOpen(false)}
        className="fixed inset-0 m-0 h-dvh max-h-dvh w-full max-w-none bg-bg p-0 text-ink backdrop:bg-ink/40"
      >
        {open && (
          <SheetBody
            value={value}
            setValue={setValue}
            close={close}
            brands={brands}
            retryBrands={loadBrands}
          />
        )}
      </dialog>
    </>
  );
}

function SheetBody({
  value,
  setValue,
  close,
  brands,
  retryBrands,
}: {
  value: string;
  setValue: (value: string) => void;
  close: () => void;
  brands: ReturnType<typeof useStoreBrands>["brands"];
  retryBrands: () => void;
}) {
  const id = useId();
  const term = value.trim();
  const suggestions = useSuggestions(value);
  const recent = useDeviceLists().recent.slice(0, 3);
  const cards = useProductCards(term ? [] : recent);
  const typed = term.length >= 2;
  return (
    <div className="flex h-full flex-col">
      <form
        method="get"
        action="/search"
        role="search"
        onSubmit={() => close()}
        className="flex items-center gap-2 border-b border-line bg-surface px-4 py-3"
      >
        <label className="sr-only" htmlFor={`${id}-q`}>
          Search products
        </label>
        <input
          id={`${id}-q`}
          type="search"
          name="q"
          value={value}
          maxLength={200}
          autoComplete="off"
          enterKeyHint="search"
          // The sheet opens to type: focus goes straight to the field.
          autoFocus
          placeholder="Search brands, flavours, puffs"
          onChange={(event) => setValue(event.target.value)}
          className="h-11 min-w-0 flex-1 rounded-pill border-[1.5px] border-line bg-surface px-4 text-base text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <button
          type="button"
          onClick={close}
          className="h-11 rounded-pill px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          Cancel
        </button>
      </form>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
        {typed ? (
          <>
            {suggestions && suggestions.brands.length > 0 && (
              <section aria-labelledby={`${id}-brands`} className="flex flex-col gap-3">
                <h3 id={`${id}-brands`} className={heading}>
                  Brands
                </h3>
                <ul className="flex flex-wrap gap-2">
                  {suggestions.brands.map((brand) => (
                    <li key={brand.slug}>
                      <Link
                        href={`/brands/${brand.slug}`}
                        prefetch={false}
                        onClick={close}
                        className={chip}
                      >
                        {brand.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {suggestions && suggestions.products.length > 0 && (
              <section aria-labelledby={`${id}-products`} className="flex flex-col gap-1">
                <h3 id={`${id}-products`} className={`${heading} pb-2`}>
                  Products
                </h3>
                <ul className="flex flex-col">
                  {suggestions.products.map((product) => (
                    <li key={product.slug}>
                      <Link
                        href={`/p/${product.slug}`}
                        prefetch={false}
                        onClick={close}
                        className={row}
                      >
                        <span className="font-medium">{product.name}</span>
                        <span className="text-xs text-ink-3">{product.brandName}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {suggestions &&
              suggestions.products.length === 0 &&
              suggestions.brands.length === 0 && (
                <p className="text-sm text-ink-2">
                  No quick matches. Search anyway to see similar products.
                </p>
              )}
            <Link
              href={`/search?${new URLSearchParams({ q: term.slice(0, 200) })}`}
              prefetch={false}
              onClick={close}
              className="flex min-h-12 items-center justify-between rounded-md border border-line bg-surface px-4 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span>See all results for “{term}”</span>
              <span aria-hidden="true">→</span>
            </Link>
          </>
        ) : (
          <>
            <section aria-labelledby={`${id}-all-brands`} className="flex flex-col gap-3">
              <h3 id={`${id}-all-brands`} className={heading}>
                Brands
              </h3>
              {brands.state === "ready" ? (
                brands.items.length ? (
                  <ul className="flex flex-wrap gap-2">
                    {brands.items.map((brand) => (
                      <li key={brand.slug}>
                        <Link
                          href={`/brands/${brand.slug}`}
                          prefetch={false}
                          onClick={close}
                          className={chip}
                        >
                          {brand.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-2">No brands yet.</p>
                )
              ) : brands.state === "failed" ? (
                <p className="text-sm text-ink-2">
                  Brands could not be loaded.{" "}
                  <button type="button" onClick={retryBrands} className="underline">
                    Try again
                  </button>
                </p>
              ) : (
                <p role="status" className="text-sm text-ink-2">
                  Loading brands…
                </p>
              )}
            </section>
            {cards.status === "ready" && cards.cards.length > 0 && (
              <section aria-labelledby={`${id}-recent`} className="flex flex-col gap-1">
                <h3 id={`${id}-recent`} className={`${heading} pb-2`}>
                  Recently viewed
                </h3>
                <ul className="flex flex-col">
                  {cards.cards.map((card) => (
                    <li key={card.slug}>
                      <Link
                        href={`/p/${card.slug}`}
                        prefetch={false}
                        onClick={close}
                        className={row}
                      >
                        <span className="font-medium">{card.name}</span>
                        <span className="text-xs text-ink-3">
                          {card.brand.name} · {displayAed(card.priceFromFils)}
                          {card.soldOut ? " · Sold out" : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
