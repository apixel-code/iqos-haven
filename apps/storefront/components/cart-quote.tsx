"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { freeDeliveryProgress } from "@/lib/cart/free-delivery";
import { displayAed } from "@/lib/store/listing";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

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
  const codeId = useId();
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
      <p role="status" className="small muted">
        Loading delivery options…
      </p>
    );
  if (delivery === "failed")
    return (
      <p className="small muted">Delivery options could not be loaded. Reload to try again.</p>
    );
  if (delivery.feeFils === null || delivery.areas.length === 0)
    return <p className="small muted">Delivery is not available yet.</p>;

  const short = current
    ? lines.filter((line) => current.insufficientStock.includes(line.variantId))
    : [];
  return (
    <div className="quote">
      <div className="field">
        <label className="label" htmlFor="checkout-area">
          Delivery area
        </label>
        <select
          id="checkout-area"
          className={areaError ? "select err" : "select"}
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
          <span id="checkout-area-error" className="errmsg">
            <Icon name="info" size="sm" />
            {areaError}
          </span>
        )}
      </div>
      {current?.coupon ? (
        // The prototype's applied-code line.
        <div className="promo-ok">
          <span>
            <Icon name="tag" size="sm" /> <span className="mono">{current.coupon.code}</span>{" "}
            applied · −<Money fils={current.discountFils} />
          </span>
          <button
            type="button"
            onClick={() => {
              setCode(null);
              setTypedCode("");
            }}
          >
            Remove<span className="sr"> code {current.coupon.code}</span>
          </button>
        </div>
      ) : (
        <form
          className="field"
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
          <label className="label" htmlFor={codeId}>
            Discount code
          </label>
          <div className="promo-f">
            <input
              id={codeId}
              className="input"
              value={typedCode}
              onChange={(event) => setTypedCode(event.target.value)}
              maxLength={32}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn btn-outline">
              Apply
            </button>
          </div>
        </form>
      )}
      <p role="status" aria-live="polite" className="small muted quote-status">
        {busy
          ? "Working out your total…"
          : !areaId
            ? "Choose your area to see delivery and your total."
            : ""}
      </p>
      {problem && (
        <p role="alert" className="errmsg">
          <Icon name="info" size="sm" />
          <span>
            {QUOTE_MESSAGES[problem]}{" "}
            {(problem === "FAILED" || problem === "RATE_LIMITED") && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setProblem(null);
                  setRetry((count) => count + 1);
                }}
              >
                Try again
              </button>
            )}
          </span>
        </p>
      )}
      {current && (
        <FreeDelivery
          thresholdFils={current.freeDeliveryThresholdFils}
          afterDiscountFils={current.merchandiseSubtotalFils - current.discountFils}
        />
      )}
      {current && (
        <>
          <dl className="totals">
            {current.coupon && (
              <div className="disc">
                <dt>Discount ({current.coupon.code})</dt>
                <dd>
                  −<Money fils={current.discountFils} />
                </dd>
              </div>
            )}
            <div>
              <dt>Delivery to {current.delivery.areaName}</dt>
              <dd>
                <Money fils={current.deliveryFeeFils} />
              </dd>
            </div>
            <div className="grand">
              <dt>Total</dt>
              <dd>
                <Money fils={current.totalFils} />
              </dd>
            </div>
          </dl>
          <p className="small muted">{current.delivery.etaText}</p>
          {short.length > 0 && (
            <p role="alert" className="errmsg">
              <Icon name="info" size="sm" />
              Not enough stock for {short.map((line) => line.name).join(", ")}. Reduce the quantity
              to continue.
            </p>
          )}
          {notice && (
            <div role="alert" className="quote-notice">
              <p>{notice}</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
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

/** Hidden while free delivery is off (always at launch: the API answers `null`). */
function FreeDelivery({
  thresholdFils,
  afterDiscountFils,
}: {
  thresholdFils: number | null;
  afterDiscountFils: number;
}) {
  const progress = freeDeliveryProgress(thresholdFils, afterDiscountFils);
  if (!progress) return null;
  return (
    <div className="fdel">
      <span>
        {progress.kind === "reached" ? (
          "Your order qualifies for free delivery."
        ) : (
          <>
            <Icon name="truck" size="sm" /> Add{" "}
            <b>
              <Money fils={progress.remainingFils} />
            </b>{" "}
            more for free delivery.
          </>
        )}
      </span>
      <span aria-hidden="true" className="bar">
        <i style={{ width: `${progress.kind === "reached" ? 100 : progress.percent}%` }} />
      </span>
    </div>
  );
}
