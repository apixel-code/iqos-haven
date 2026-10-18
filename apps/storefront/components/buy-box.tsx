"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { StoreProductResponse } from "@ih/contracts";
import { CART_LIMITS } from "@/lib/cart/cart";
import { openCartSheet } from "@/lib/cart/sheet";
import { addToCart } from "@/lib/cart/store";
import { discountPercent } from "@/lib/store/listing";
import {
  impliedChoices,
  offeredOptions,
  optionLabel,
  resolveSelection,
  valueState,
  variantLabel,
} from "@/lib/store/selection";
import { Money } from "@/components/money";

type Feedback = { kind: "added" | "error"; text: string } | null;

/**
 * Option choice, price, stock and add-to-cart for one product (product page and quick add).
 * Nothing is preselected when there is a real choice, and the shopper's choice is never swapped
 * for another variant: a sold-out or unoffered combination simply cannot be added.
 */
export function BuyBox({
  product,
  compact = false,
  onAdded,
  whatsappHref,
}: {
  product: StoreProductResponse;
  compact?: boolean;
  /** WhatsApp link for the sticky bar on phones (product page only). */
  whatsappHref?: string | null;
  /** Called after a successful add, before the cart sheet opens (quick add closes itself). */
  onAdded?: () => void;
}) {
  const options = offeredOptions(product);
  const [chosen, setChosen] = useState<Record<string, string>>(() => impliedChoices(options));
  const [quantity, setQuantity] = useState(1);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const formId = useId();
  const mainAdd = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Sticky bar on phones (parity G-S5): only once the main button has scrolled up out of view.
  const [sticky, setSticky] = useState(false);
  useEffect(() => {
    const button = mainAdd.current;
    if (compact || !button) return;
    const observer = new IntersectionObserver(([entry]) =>
      setSticky(!entry!.isIntersecting && entry!.boundingClientRect.top < 80),
    );
    observer.observe(button);
    // Room below the page on phones, so the bar never covers the footer's last lines.
    document.body.classList.add("has-sticky-buy");
    return () => {
      observer.disconnect();
      document.body.classList.remove("has-sticky-buy");
    };
  }, [compact]);
  const selection = resolveSelection(product, chosen);
  const variant = "variant" in selection ? selection.variant : null;
  const prices = product.variants.map((item) => item.priceFils);
  const lowest = Math.min(...prices);
  const priceFils = variant ? variant.priceFils : lowest;
  const compareAt = variant ? variant.compareAtPriceFils : null;
  const saving = discountPercent(priceFils, compareAt);
  const varies = !variant && new Set(prices).size > 1;

  const stock =
    selection.status === "ready"
      ? { tone: "ok", text: "In stock" }
      : selection.status === "sold_out"
        ? { tone: "no", text: options.length ? "This option is sold out" : "Sold out" }
        : selection.status === "unavailable"
          ? { tone: "no", text: "This combination isn't available" }
          : product.soldOut
            ? { tone: "no", text: "Sold out" }
            : null;

  /** From the sticky bar: an incomplete choice takes the shopper back to the options. */
  function addFromBar() {
    if (selection.status === "incomplete") {
      const missing = selection.missing[0];
      const fieldset = root.current?.querySelector<HTMLElement>(
        `[data-option="${CSS.escape(missing ?? "")}"]`,
      );
      fieldset?.scrollIntoView({ behavior: "smooth", block: "center" });
      fieldset?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }
    add();
  }

  function add() {
    if (selection.status === "incomplete") {
      setFeedback({
        kind: "error",
        text: `Choose ${selection.missing.map((name) => optionLabel(name).toLowerCase()).join(" and ")} first.`,
      });
      return;
    }
    if (selection.status !== "ready") return;
    const result = addToCart(
      {
        variantId: selection.variant.id,
        productSlug: product.slug,
        snapshot: {
          name: product.name,
          brand: product.brand.name,
          options: variantLabel(product, selection.variant.attributes),
          priceFils: selection.variant.priceFils,
        },
      },
      quantity,
    );
    setFeedback(
      result.full
        ? { kind: "error", text: "Your cart is full. Remove an item to add another." }
        : {
            kind: "added",
            text: result.capped
              ? `Added. You can have up to ${CART_LIMITS.maxQuantity} of one item: ${result.quantity} in your cart.`
              : `Added to cart: ${result.quantity} in your cart.`,
          },
    );
    // The cart sheet shows what is now in the cart and the way on (parity G-S1).
    if (!result.full) {
      onAdded?.();
      openCartSheet();
    }
  }

  const blocked =
    selection.status === "sold_out" || selection.status === "unavailable" || product.soldOut;
  return (
    <div ref={root} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className={`font-semibold ${compact ? "text-xl" : "text-3xl"} ${saving ? "text-coral" : ""}`}
          >
            {varies && <span className="text-base font-medium text-ink-2">From </span>}
            <Money fils={priceFils} />
          </span>
          {compareAt !== null && (
            <span className="text-sm text-ink-3 line-through">
              <span className="sr-only">Was </span>
              <Money fils={compareAt} />
            </span>
          )}
          {saving !== null && (
            <span className="rounded-pill bg-coral px-2 py-0.5 text-xs font-semibold text-white">
              Save {saving}%
            </span>
          )}
        </p>
        <p aria-live="polite" className="min-h-5 text-sm">
          {stock && (
            <span className={stock.tone === "ok" ? "text-success" : "text-error"}>
              {stock.text}
            </span>
          )}
        </p>
      </div>

      {options
        .filter((option) => option.values.length > 1)
        .map((option) => (
          <fieldset key={option.name} data-option={option.name} className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              {optionLabel(option.name)}
              {chosen[option.name] ? (
                <span className="font-normal text-ink-2">: {chosen[option.name]}</span>
              ) : (
                <span className="font-normal text-ink-3"> · choose one</span>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map((value) => {
                const state = valueState(product.variants, chosen, option.name, value);
                const selected = chosen[option.name] === value;
                return (
                  <label
                    key={value}
                    className={`inline-flex min-h-10 cursor-pointer items-center rounded-pill border-[1.5px] px-4 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                      selected ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink"
                    } ${state === "available" ? "" : "border-dashed text-ink-3 line-through"}`}
                  >
                    <input
                      type="radio"
                      name={`${formId}-${option.name}`}
                      value={value}
                      checked={selected}
                      onChange={() => {
                        setChosen((current) => ({ ...current, [option.name]: value }));
                        setFeedback(null);
                      }}
                      className="sr-only"
                    />
                    {value}
                    {state !== "available" && (
                      <span className="sr-only">
                        ,{" "}
                        {state === "sold_out"
                          ? "sold out"
                          : "not available with your other choices"}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Quantity"
          className="inline-flex h-12 items-center rounded-pill border-[1.5px] border-line bg-surface"
        >
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={quantity <= 1}
            onClick={() => setQuantity((current) => Math.max(1, current - 1))}
            className="size-12 rounded-pill text-lg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus"
          >
            −
          </button>
          <output aria-live="polite" className="w-8 text-center text-sm font-medium">
            {quantity}
          </output>
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={quantity >= CART_LIMITS.maxQuantity}
            onClick={() => setQuantity((current) => Math.min(CART_LIMITS.maxQuantity, current + 1))}
            className="size-12 rounded-pill text-lg disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus"
          >
            +
          </button>
        </div>
        <button
          ref={mainAdd}
          type="button"
          disabled={blocked}
          onClick={add}
          className="inline-flex h-12 min-w-40 flex-1 items-center justify-center rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {selection.status === "sold_out" || product.soldOut
            ? "Sold out"
            : selection.status === "unavailable"
              ? "Not available"
              : "Add to cart"}
        </button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`min-h-5 text-sm ${feedback?.kind === "error" ? "text-error" : "text-success"}`}
      >
        {feedback?.text}
        {feedback?.kind === "added" && (
          <>
            {" "}
            <a href="/cart" className="font-medium text-ink underline underline-offset-2">
              View cart
            </a>
          </>
        )}
      </p>
      {!compact && (
        // Phones only (parity G-S5, ADR 0088). Off-screen and inert until the main button has
        // scrolled up out of view, so it is never focusable twice.
        <div
          aria-label="Add to cart"
          role="region"
          inert={!sticky}
          className={`fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-line bg-surface px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] shadow-3 transition-transform duration-300 ease-brand motion-reduce:transition-none md:hidden ${
            sticky ? "translate-y-0" : "translate-y-[110%]"
          }`}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <b className="truncate text-sm font-semibold">{product.name}</b>
            <span className="truncate text-xs text-ink-2">
              {/* The price first, so it is never the part cut off. */}
              {varies ? "From " : ""}
              <Money fils={priceFils} />
              {variant
                ? variantLabel(product, variant.attributes) &&
                  ` · ${variantLabel(product, variant.attributes)}`
                : options.length > 0 && " · Choose an option"}
            </span>
          </div>
          {/* Controls only while shown: with the main button on screen there is one Add to cart. */}
          {sticky && (
            <>
              {whatsappHref && (
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Ask on WhatsApp"
                  className="inline-flex size-12 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-line text-sm font-semibold text-wa hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="size-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12Z"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              )}
              <button
                type="button"
                disabled={blocked}
                onClick={addFromBar}
                className="inline-flex h-12 shrink-0 items-center justify-center rounded-pill bg-primary px-5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {selection.status === "sold_out" || product.soldOut
                  ? "Sold out"
                  : selection.status === "unavailable"
                    ? "Not available"
                    : "Add to cart"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
