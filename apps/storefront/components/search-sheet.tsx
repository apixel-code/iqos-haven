"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { Icon } from "@/components/icons";
import { useStoreBrands, useSuggestions } from "@/lib/store/client-hooks";
import { Money } from "@/components/money";
import { Sheet } from "./sheet";

/**
 * Mobile search (parity G-S3, ADR 0087) as the prototype's `searchSheet` (V-S6): a sheet from the top, opened from the
 * header below the `md` breakpoint (wider screens keep the inline search box). Before typing
 * it offers the brands and the products recently viewed on this device; while typing, the
 * suggested brands and products and a link to every result. It is the same plain GET form to
 * /search, so Enter always searches. Brands load when the sheet first opens.
 */
const OPEN_SEARCH = "ih:open-search";
/** Opens the search sheet from elsewhere on the page (the home hero's search button). */
export function openSearchSheet() {
  window.dispatchEvent(new Event(OPEN_SEARCH));
}

export function SearchSheet() {
  const [open, setOpen] = useState(false);
  // Mounted from the first open on: closing on submit must not take the form out of the page
  // before the browser has sent it.
  const [used, setUsed] = useState(false);
  const [value, setValue] = useState("");
  const pathname = usePathname();
  const close = useCallback(() => setOpen(false), []);
  // A followed link closes the sheet, including Back and Forward.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  const { brands, load: loadBrands, ensure: ensureBrands } = useStoreBrands();
  const show = useCallback(() => {
    setOpen(true);
    setUsed(true);
    ensureBrands();
  }, [ensureBrands]);
  useEffect(() => {
    window.addEventListener(OPEN_SEARCH, show);
    return () => window.removeEventListener(OPEN_SEARCH, show);
  }, [show]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
        // The prototype's search button (`ibtn not-lg`): below the width of the header search bar.
        className="ibtn not-lg"
        aria-label="Search"
      >
        <Icon name="search" />
      </button>
      <Sheet open={open} onClose={close} title="Search" side="top" head={null} bare>
        {used && (
          <SheetBody
            value={value}
            setValue={setValue}
            close={close}
            brands={brands}
            retryBrands={loadBrands}
          />
        )}
      </Sheet>
    </>
  );
}

/** The typed text marked in a suggestion (prototype `hl`). */
function Marked({ text, term }: { text: string; term: string }) {
  const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + term.length)}</mark>
      {text.slice(at + term.length)}
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
    <>
      {/* The prototype's `sq-box`; the same plain GET form to /search, so Enter always searches. */}
      <form method="get" action="/search" role="search" onSubmit={() => close()} className="sq-box">
        <Icon name="search" />
        <label className="sr" htmlFor={`${id}-q`}>
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
          placeholder="Search vapes, brands, flavours"
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
          Cancel
        </button>
      </form>
      <div className="sh-body">
        {typed ? (
          <>
            {suggestions && suggestions.brands.length > 0 && (
              <section className="sq-sec" aria-labelledby={`${id}-brands`}>
                <h3 id={`${id}-brands`}>Brands</h3>
                <ul className="sq-chips">
                  {suggestions.brands.map((brand) => (
                    <li key={brand.slug}>
                      <Link
                        href={`/brands/${brand.slug}`}
                        prefetch={false}
                        onClick={close}
                        className="chip"
                      >
                        <Marked text={brand.name} term={term} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {suggestions && suggestions.products.length > 0 && (
              <section className="sq-sec" aria-labelledby={`${id}-products`}>
                <h3 id={`${id}-products`}>Products</h3>
                <ul className="sq-list">
                  {suggestions.products.map((product) => (
                    <li key={product.slug}>
                      <Link
                        href={`/p/${product.slug}`}
                        prefetch={false}
                        onClick={close}
                        className="sq-item no-th"
                      >
                        <span className="t">
                          <b>
                            <Marked text={product.name} term={term} />
                          </b>
                          <span>{product.brandName}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {suggestions &&
              suggestions.products.length === 0 &&
              suggestions.brands.length === 0 && (
                <p className="small muted sq-none">
                  No quick matches. Search anyway to see similar products.
                </p>
              )}
            <Link
              href={`/search?${new URLSearchParams({ q: term.slice(0, 200) })}`}
              prefetch={false}
              onClick={close}
              className="sq-all"
            >
              See all results for “{term}” <Icon name="arrow-r" />
            </Link>
          </>
        ) : (
          <>
            <section className="sq-sec" aria-labelledby={`${id}-all-brands`}>
              <h3 id={`${id}-all-brands`}>Brands</h3>
              {brands.state === "ready" ? (
                brands.items.length ? (
                  <ul className="sq-chips">
                    {brands.items.map((brand) => (
                      <li key={brand.slug}>
                        <Link
                          href={`/brands/${brand.slug}`}
                          prefetch={false}
                          onClick={close}
                          className="chip"
                        >
                          {brand.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">No brands yet.</p>
                )
              ) : brands.state === "failed" ? (
                <p className="small muted">
                  Brands could not be loaded.{" "}
                  <button type="button" className="link" onClick={retryBrands}>
                    Try again
                  </button>
                </p>
              ) : (
                <p role="status" className="small muted">
                  Loading brands…
                </p>
              )}
            </section>
            {cards.status === "ready" && cards.cards.length > 0 && (
              <section className="sq-sec" aria-labelledby={`${id}-recent`}>
                <h3 id={`${id}-recent`}>Recently viewed</h3>
                <ul className="sq-list">
                  {cards.cards.map((card) => (
                    <li key={card.slug}>
                      <Link
                        href={`/p/${card.slug}`}
                        prefetch={false}
                        onClick={close}
                        className="sq-item"
                      >
                        <span className="th">
                          {card.image && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={card.image.urls.thumb} alt="" width={52} height={60} />
                          )}
                        </span>
                        <span className="t">
                          <b>{card.name}</b>
                          <span>
                            {card.brand.name}
                            {card.soldOut ? " · Sold out" : ""}
                          </span>
                        </span>
                        <span className="price">
                          <span className="now">
                            <Money fils={card.priceFromFils} />
                          </span>
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
    </>
  );
}
