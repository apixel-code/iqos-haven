"use client";
import { useEffect, useState } from "react";
import { orderItemChoicesResponseSchema, type OrderItemChoice } from "@ih/contracts";
import { managementError, managementRequest } from "../lib/management";
import { money } from "../lib/orders";

/** "Mint · 20 mg · SKU" — what staff read back to the customer. */
export const choiceLabel = (choice: OrderItemChoice) =>
  [choice.options, choice.sku].filter(Boolean).join(" · ");

/**
 * Product/variant picker of the manual order and the order edit (parity G-A1, ADR 0080).
 * Lists only what the order transaction would accept now; the unit price is a guide, the
 * server quote decides. A variant already in the order cannot be picked twice.
 */
export function OrderItemPicker({
  taken,
  disabled,
  onPick,
}: {
  taken: ReadonlySet<string>;
  disabled?: boolean;
  onPick: (choice: OrderItemChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ q: string; items: OrderItemChoice[] } | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const active = new AbortController();
    // Wait for a pause in typing; a newer search cancels the older one.
    const timer = setTimeout(() => {
      const q = query.trim();
      managementRequest(
        `/orders/item-choices${q ? `?${new URLSearchParams({ q })}` : ""}`,
        orderItemChoicesResponseSchema,
        "GET",
        undefined,
        active.signal,
      )
        .then((response) => {
          setMessage("");
          setResult({ q, items: response.items });
        })
        .catch((error) => {
          if (!active.signal.aborted) setMessage(managementError(error));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      active.abort();
    };
  }, [query]);
  return (
    <div className="item-picker wide-field">
      <label>
        <span>Search products</span>
        <input
          type="search"
          value={query}
          maxLength={100}
          placeholder="Name, brand or SKU"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {message && <p role="alert">{message}</p>}
      {result && (
        <ul className="item-picks" aria-label="Matching products">
          {result.items.map((choice) => {
            const added = taken.has(choice.variantId);
            return (
              <li key={choice.variantId}>
                <span className="item-pick-text">
                  <strong>
                    {choice.brandName} {choice.productName}
                  </strong>
                  <small className="muted">{choiceLabel(choice)}</small>
                </span>
                <span className="item-pick-price">
                  {money(choice.unitPriceFils)}
                  {choice.soldOut && <span className="badge">Sold out</span>}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled || added || choice.soldOut}
                  aria-label={`Add ${choice.productName} ${choiceLabel(choice)}`}
                  onClick={() => onPick(choice)}
                >
                  {added ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
          {result.items.length === 0 && (
            <li className="muted">
              {result.q
                ? "No orderable product matches. Search by product name, brand or SKU."
                : "No product can be ordered yet: publish one with an active option and a price."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
