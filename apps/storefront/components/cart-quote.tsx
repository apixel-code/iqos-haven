"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMIRATE_NAMES,
  storeDeliveryResponseSchema,
  storeQuoteResponseSchema,
  UAE_EMIRATES,
  type StoreDeliveryResponse,
  type StoreQuoteResponse,
} from "@ih/contracts";
import {
  acceptedFrom,
  canProceed,
  compareQuotes,
  dropsCoupon,
  QUOTE_MESSAGES,
  quoteProblem,
  requestKey,
  type AcceptedQuote,
  type QuoteProblem,
} from "@/lib/cart/quote";
import type { QuoteChoice } from "@/lib/checkout/memory";
import { displayAed } from "@/lib/store/listing";

interface Line {
  variantId: string;
  quantity: number;
  name: string;
}
/** Exactly what was priced and accepted: what an order made from this total must send. */
export interface AcceptedOrderQuote {
  lines: Array<{ variantId: string; quantity: number }>;
  areaId: string;
  couponCode: string | null;
  token: string;
  totalFils: number;
}
const FIELD =
  "h-11 w-full rounded-md border border-line bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * The authoritative total for the cart (roadmap step 71, ADR 0041). The shopper picks a
 * delivery area and may enter one code; the API answers with the total and a token for it.
 * A total that changes without the shopper changing anything must be accepted explicitly.
 * The chosen area, the code and the accepted total live in memory only.
 */
export function CartQuote({
  lines,
  blocked,
  onUnavailable,
  onReady,
  initial,
  onChoice,
  onAccepted,
  refresh = 0,
  areaError,
}: {
  /** Buyable lines of the cart. */
  lines: readonly Line[];
  /** Lines that must be removed first; no total is asked for while there are any. */
  blocked: number;
  /** A line stopped being offered since the cart was last refreshed. */
  onUnavailable: () => void;
  /** Whether the shopper holds an accepted, current total. */
  onReady: (ready: boolean) => void;
  /** Area and code chosen earlier in this visit (memory only). */
  initial?: QuoteChoice;
  /** The shopper chose an area or a code. */
  onChoice?: (choice: QuoteChoice) => void;
  /** The accepted, current total with what it was for; null while there is none. */
  onAccepted?: (accepted: AcceptedOrderQuote | null) => void;
  /** Change it to ask for the same total again (the order route said it moved). */
  refresh?: number;
  /** Shown under the area field by a form that requires it. */
  areaError?: string | undefined;
}) {
  const [delivery, setDelivery] = useState<StoreDeliveryResponse | null | "failed">(null);
  const [areaId, setAreaId] = useState(initial?.areaId ?? "");
  const [typedCode, setTypedCode] = useState(initial?.couponCode ?? "");
  const [code, setCode] = useState<string | null>(initial?.couponCode ?? null);
  const [quote, setQuote] = useState<StoreQuoteResponse | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [accepted, setAccepted] = useState<AcceptedQuote | null>(null);
  const [problem, setProblem] = useState<QuoteProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  // The total accepted with a code the server then refused; see `compareQuotes`.
  const droppedFrom = useRef<AcceptedQuote | null>(null);
  // The request effect compares against the latest accepted total without re-running for it.
  const acceptedRef = useRef(accepted);
  useEffect(() => {
    acceptedRef.current = accepted;
  }, [accepted]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/store/delivery", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("delivery"))))
      .then((body: unknown) => setDelivery(storeDeliveryResponseSchema.parse(body)))
      .catch(() => {
        if (!controller.signal.aborted) setDelivery("failed");
      });
    return () => controller.abort();
  }, []);

  const request = useMemo(
    () =>
      areaId && lines.length > 0 && blocked === 0
        ? {
            lines: lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
            areaId,
            couponCode: code,
          }
        : null,
    [areaId, blocked, code, lines],
  );
  const key = request ? requestKey(request) : "";

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    // A short pause so a run of quantity taps asks for one total, not one per tap.
    const timer = setTimeout(() => {
      setBusy(true);
      fetch("/api/v1/store/cart/quote", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { code?: string };
            } | null;
            const found = quoteProblem(response.status, body?.error?.code);
            setProblem(found);
            if (dropsCoupon(found)) {
              // Continue without the code: the next request prices the cart on its own. If the
              // shopper had accepted a total with this code, the new one needs their accept.
              droppedFrom.current =
                acceptedRef.current?.requestKey === key ? acceptedRef.current : null;
              setCode(null);
              return;
            }
            setQuote(null);
            if (found === "VARIANT_UNAVAILABLE") onUnavailable();
            return;
          }
          const next = storeQuoteResponseSchema.parse(await response.json());
          const before = droppedFrom.current ?? acceptedRef.current;
          const outcome = compareQuotes(acceptedRef.current, key, next, droppedFrom.current);
          droppedFrom.current = null;
          if (outcome === "changed")
            setNotice(
              `Your total changed from ${displayAed(before!.totalFils)} to ${displayAed(next.totalFils)}. Check it and accept to continue.`,
            );
          else {
            setAccepted(acceptedFrom(key, next));
            setNotice(null);
          }
          setQuote(next);
          setQuoteKey(key);
          // A coupon message stays next to the total priced without the code.
          setProblem((current) =>
            current && dropsCoupon(current) && !request.couponCode ? current : null,
          );
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setProblem("FAILED");
            setQuote(null);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setBusy(false);
    };
    // `retry` and `refresh` ask again for the same request (expired token, "Try again").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, refresh]);

  // An accepted total is only good until its token expires: ask again then.
  useEffect(() => {
    if (!quote || quoteKey !== key) return;
    const wait = Date.parse(quote.quote.expiresAt) - Date.now();
    const timer = setTimeout(() => setRetry((count) => count + 1), Math.max(wait, 1000));
    return () => clearTimeout(timer);
  }, [quote, quoteKey, key]);

  const current = request && quoteKey === key ? quote : null;
  // eslint-disable-next-line react-hooks/purity -- the clock decides only whether a token is still usable
  const ready = canProceed(accepted, key, current, Date.now());
  useEffect(() => onReady(ready), [onReady, ready]);
  useEffect(() => onChoice?.({ areaId, couponCode: code }), [onChoice, areaId, code]);
  const token = ready ? accepted!.token : null;
  useEffect(() => {
    onAccepted?.(token && request ? { ...request, token, totalFils: accepted!.totalFils } : null);
    // `key` stands for the request and `token` for the accepted total.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAccepted, token, key]);

  if (delivery === null)
    return (
      <p role="status" className="text-sm text-ink-2">
        Loading delivery options…
      </p>
    );
  if (delivery === "failed")
    return (
      <p className="text-sm text-ink-2">
        Delivery options could not be loaded. Reload to try again.
      </p>
    );
  if (delivery.feeFils === null || delivery.areas.length === 0)
    return <p className="text-sm text-ink-2">Delivery is not available yet.</p>;

  const short = current
    ? lines.filter((line) => current.insufficientStock.includes(line.variantId))
    : [];
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Delivery area</span>
        <select
          id="checkout-area"
          className={FIELD}
          value={areaId}
          aria-invalid={areaError ? true : undefined}
          aria-describedby={areaError ? "checkout-area-error" : undefined}
          onChange={(event) => {
            setAreaId(event.target.value);
            droppedFrom.current = null;
            setProblem(null);
          }}
        >
          <option value="">Select your area</option>
          {UAE_EMIRATES.filter((emirate) =>
            delivery.areas.some((area) => area.emirate === emirate),
          ).map((emirate) => (
            <optgroup key={emirate} label={EMIRATE_NAMES[emirate]}>
              {delivery.areas
                .filter((area) => area.emirate === emirate)
                .map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {areaError && (
          <span id="checkout-area-error" className="text-sm font-medium text-error">
            {areaError}
          </span>
        )}
      </label>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = typedCode.trim();
          droppedFrom.current = null;
          setProblem(null);
          setCode(next ? next : null);
          // Applying the same code again asks again.
          if ((next || null) === code) setRetry((count) => count + 1);
        }}
      >
        <label className="flex flex-1 flex-col gap-1.5 text-sm">
          <span className="font-medium">Discount code</span>
          <input
            className={FIELD}
            value={typedCode}
            onChange={(event) => setTypedCode(event.target.value)}
            maxLength={32}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="submit"
          className="h-11 rounded-pill border border-line px-4 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Apply
        </button>
      </form>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-ink-2">
        {busy
          ? "Working out your total…"
          : !areaId
            ? "Choose your area to see delivery and your total."
            : ""}
      </p>
      {problem && (
        <p role="alert" className="text-sm font-medium text-error">
          {QUOTE_MESSAGES[problem]}{" "}
          {(problem === "FAILED" || problem === "RATE_LIMITED") && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setProblem(null);
                setRetry((count) => count + 1);
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {current && (
        <>
          <dl className="flex flex-col gap-2 text-sm">
            {current.coupon && (
              <div className="flex justify-between gap-4">
                <dt>
                  Discount ({current.coupon.code}){" "}
                  <button
                    type="button"
                    className="text-ink-2 underline underline-offset-2"
                    onClick={() => {
                      setCode(null);
                      setTypedCode("");
                    }}
                  >
                    Remove
                  </button>
                </dt>
                <dd className="whitespace-nowrap">−{displayAed(current.discountFils)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt>Delivery to {current.delivery.areaName}</dt>
              <dd>{displayAed(current.deliveryFeeFils)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-line pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd>{displayAed(current.totalFils)}</dd>
            </div>
          </dl>
          <p className="text-xs text-ink-3">{current.delivery.etaText}</p>
          {short.length > 0 && (
            <p role="alert" className="text-sm font-medium text-error">
              Not enough stock for {short.map((line) => line.name).join(", ")}. Reduce the quantity
              to continue.
            </p>
          )}
          {notice && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm"
            >
              <p className="font-medium">{notice}</p>
              <button
                type="button"
                className="h-10 w-fit rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                onClick={() => {
                  setAccepted(acceptedFrom(key, current));
                  setNotice(null);
                }}
              >
                Accept new total
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
