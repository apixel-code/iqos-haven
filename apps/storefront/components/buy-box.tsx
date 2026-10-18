"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

type Feedback = { kind: "added" | "note" | "error"; text: string } | null;

/** Options shown as the prototype's segmented control rather than chips. */
const SEGMENTED = new Set(["nicotine", "strength"]);
/** How long the main button says "Added" (prototype). */
const ADDED_MS = 1500;

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
  save,
}: {
  product: StoreProductResponse;
  compact?: boolean;
  /** The heart beside the main button (product page only). */
  save?: ReactNode;
  /** WhatsApp link for the sticky bar on phones (product page only). */
  whatsappHref?: string | null;
  /** Called after a successful add, before the cart sheet opens (quick add closes itself). */
  onAdded?: () => void;
}) {
  const options = offeredOptions(product);
  const [chosen, setChosen] = useState<Record<string, string>>(() => impliedChoices(options));
  const [quantity, setQuantity] = useState(1);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(false), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [added]);
  const formId = useId();
  const mainAdd = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Sticky bar on phones (parity G-S5): only once the main button has scrolled up out of view.
  const [sticky, setSticky] = useState(false);
  useEffect(() => {
    const button = mainAdd.current;
    if (compact || !button) return;
    // Measured on scroll, not by an IntersectionObserver: a jump (the "reviews" link, a restored
    // scroll position) can pass the button without ever crossing the viewport edge.
    let frame = 0;
    const measure = () => {
      frame = 0;
      setSticky(button.getBoundingClientRect().bottom < 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    // Room below the page on phones, so the bar never covers the footer's last lines.
    document.body.classList.add("has-sticky-buy");
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
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
        : result.capped
          ? {
              kind: "note",
              text: `Added. You can have up to ${CART_LIMITS.maxQuantity} of one item: ${result.quantity} in your cart.`,
            }
          : { kind: "added", text: `Added to cart: ${result.quantity} in your cart.` },
    );
    if (!result.full) setAdded(true);
    // The cart sheet shows what is now in the cart and the way on (parity G-S1).
    if (!result.full) {
      onAdded?.();
      openCartSheet();
    }
  }

  const blocked =
    selection.status === "sold_out" || selection.status === "unavailable" || product.soldOut;
  const label =
    selection.status === "sold_out" || product.soldOut
      ? "Sold out"
      : selection.status === "unavailable"
        ? "Not available"
        : "Add to cart";
  return (
    <div ref={root} className="buy-box">
      <div className="buy-price">
        <div className="price">
          <span className={saving ? "now sale" : "now"}>
            {varies && <span className="from">From </span>}
            <Money fils={priceFils} />
          </span>
          {compareAt !== null && (
            <span className="was">
              <span className="sr">Was </span>
              <Money fils={compareAt} />
            </span>
          )}
          {saving !== null && <span className="badge badge-sale">Save {saving}%</span>}
        </div>
        <p aria-live="polite" className="buy-stock">
          {stock && (
            <span className={stock.tone === "ok" ? "stock" : "stock no"}>
              <i aria-hidden="true" />
              {stock.text}
            </span>
          )}
        </p>
      </div>

      {options
        .filter((option) => option.values.length > 1)
        .map((option) => (
          <fieldset key={option.name} data-option={option.name} className="opt-g">
            <legend>
              {optionLabel(option.name)}
              {chosen[option.name] ? (
                <>
                  : <span>{chosen[option.name]}</span>
                </>
              ) : (
                <span> · choose one</span>
              )}
            </legend>
            {/* Radio inputs styled as the prototype's chips (`flv`) or segments (`seg`). */}
            <div className={SEGMENTED.has(option.name) ? "seg" : "flv"}>
              {option.values.map((value) => {
                const state = valueState(product.variants, chosen, option.name, value);
                const selected = chosen[option.name] === value;
                return (
                  <label key={value} className={state === "available" ? undefined : "oos"}>
                    <input
                      type="radio"
                      name={`${formId}-${option.name}`}
                      value={value}
                      checked={selected}
                      onChange={() => {
                        setChosen((current) => ({ ...current, [option.name]: value }));
                        setFeedback(null);
                      }}
                      className="sr"
                    />
                    {value}
                    {state !== "available" && (
                      <span className="sr">
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

      <div className="buy-row">
        <div className="stepper" role="group" aria-label="Quantity">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={quantity <= 1}
            onClick={() => setQuantity((current) => Math.max(1, current - 1))}
          >
            <Icon name="minus" />
          </button>
          <output aria-live="polite">{quantity}</output>
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={quantity >= CART_LIMITS.maxQuantity}
            onClick={() => setQuantity((current) => Math.min(CART_LIMITS.maxQuantity, current + 1))}
          >
            <Icon name="plus" />
          </button>
        </div>
        <button
          ref={mainAdd}
          type="button"
          disabled={blocked}
          onClick={add}
          className={
            blocked
              ? "btn btn-lg"
              : added
                ? "btn btn-primary btn-lg added"
                : "btn btn-primary btn-lg"
          }
        >
          {added && !blocked ? (
            <>
              <Icon name="check" /> Added
            </>
          ) : (
            label
          )}
        </button>
        {save}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          feedback?.kind === "error"
            ? "buy-note err"
            : feedback?.kind === "added"
              ? "sr"
              : "buy-note"
        }
      >
        {/* A plain add is shown by the button and the cart sheet; screen readers hear it here. */}
        {feedback?.text}
      </p>
      {!compact && (
        // Phones only (parity G-S5, ADR 0088). Off-screen and inert until the main button has
        // scrolled up out of view, so it is never focusable twice.
        <div
          aria-label="Add to cart"
          role="region"
          inert={!sticky}
          className={sticky ? "satc store-satc show" : "satc store-satc"}
        >
          <div className="t">
            <b>{product.name}</b>
            <span>
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
                  className="ibtn wa-mini"
                >
                  <Icon name="wa" />
                </a>
              )}
              <button
                type="button"
                disabled={blocked}
                onClick={addFromBar}
                className={blocked ? "btn" : "btn btn-primary"}
              >
                {label}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
