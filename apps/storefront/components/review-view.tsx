"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { REVIEW_AUTHOR_MAX, REVIEW_BODY_MAX, REVIEW_TITLE_MAX } from "@ih/contracts";
import {
  ageRecheckHref,
  EMPTY_REVIEW,
  proofView,
  reviewRequest,
  submitOutcome,
  tokenFromHash,
  type ProofView,
  type ReviewErrors,
  type ReviewField,
  type ReviewForm,
} from "@/lib/reviews";

const PANEL = "flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 sm:p-6";
const INPUT =
  "min-h-12 w-full rounded-md border border-line-2 bg-surface px-3.5 py-3 text-base hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-error aria-[invalid=true]:bg-error-soft";
const PRIMARY =
  "inline-flex h-12 items-center justify-center self-start rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60";
const STAR_LABELS = ["Poor", "Fair", "Good", "Very good", "Excellent"] as const;

/** POST with the token in the body; never cached, never with a Referer. */
const send = (path: string, body: unknown) =>
  fetch(`/api/v1/store/reviews${path}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type PageState = { kind: "loading" } | { kind: "missing" } | ProofView;

/**
 * Review page (roadmap step 94, ADR 0062). The token is read from the fragment once and removed
 * from the address bar, so it stays out of history and anything the page loads later. It lives
 * in this component's memory only: a reload means opening the link from the message again.
 * Every review is checked by the store before it is shown.
 */
export function ReviewView() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  // Read once: the fragment is removed straight away, so a second run must not read it again.
  const arrived = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (arrived.current === undefined) {
      arrived.current = tokenFromHash(window.location.hash);
      if (window.location.hash)
        window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    if (arrived.current) setToken(arrived.current);
    else setState({ kind: "missing" });
  }, []);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    send("/proof", { token })
      .then(async (response) => {
        const view = proofView(response.status, await response.json().catch(() => null));
        if (live) setState(view);
      })
      .catch(() => live && setState({ kind: "failed", limited: false }));
    return () => {
      live = false;
    };
  }, [token, attempt]);

  // The age ticket ran out while the page was open: back through the question, link kept.
  useEffect(() => {
    if (state.kind === "age" && token) window.location.assign(ageRecheckHref(token));
  }, [state.kind, token]);

  if (state.kind === "loading")
    return (
      <p role="status" className="py-9 text-sm text-ink-2">
        Opening your review link…
      </p>
    );
  if (state.kind === "age" && token) return null;
  if (state.kind === "missing" || state.kind === "invalid" || state.kind === "age")
    return (
      <Notice title="This review link can't be used">
        {state.kind === "missing"
          ? "Open the review link from the message we sent you. The link only works when opened as sent."
          : "It may have expired, been replaced by a newer link, or every product has been reviewed already. Ask us on WhatsApp for a new link."}
      </Notice>
    );
  if (state.kind === "failed")
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-6">
        <h1 className="text-2xl font-semibold">We couldn&apos;t open your review link</h1>
        <p className="text-sm text-ink-2">
          {state.limited
            ? "Too many tries. Wait a minute and try again."
            : "Something went wrong on our side. Try again in a moment."}
        </p>
        <button
          type="button"
          className={PRIMARY}
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </button>
      </div>
    );

  const products = state.proof.products;
  const open = products.filter((product) => !sent.includes(product.productId));
  return (
    <div className="mx-auto flex max-w-[680px] flex-col gap-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Review your order</h1>
        <p className="text-sm text-ink-2">
          Tell other customers what you thought. Reviews are checked by our team before they appear,
          and only your rating, title, review and the name you choose are shown.
        </p>
      </div>
      {open.length === 0 ? (
        <Notice title="Thank you for your review" inline>
          We&apos;ll check it shortly. Once approved, it will appear on the product page.
        </Notice>
      ) : (
        open.map((product) => (
          <ProductReview
            key={product.productId}
            token={token!}
            productId={product.productId}
            name={product.name}
            onSent={(remaining) => {
              setSent((list) => [...list, product.productId]);
              if (remaining === 0) setSent(products.map((item) => item.productId));
            }}
            onInvalid={() => setState({ kind: "invalid" })}
            onAge={() => setState({ kind: "age" })}
          />
        ))
      )}
      {sent.length > 0 && open.length > 0 && (
        <p role="status" className="text-sm text-success">
          Thank you. We&apos;ll check your review shortly.
        </p>
      )}
    </div>
  );
}

function Notice({
  title,
  children,
  inline,
}: {
  title: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-start gap-3 ${inline ? PANEL : "mx-auto max-w-[680px] py-6"}`}
    >
      {inline ? (
        <h2 className="text-xl font-semibold">{title}</h2>
      ) : (
        <h1 className="text-2xl font-semibold">{title}</h1>
      )}
      <p className="text-sm text-ink-2">{children}</p>
      <Link
        href="/shop"
        prefetch={false}
        className="text-sm font-medium underline underline-offset-2"
      >
        Continue shopping
      </Link>
    </div>
  );
}

function ProductReview({
  token,
  productId,
  name,
  onSent,
  onInvalid,
  onAge,
}: {
  token: string;
  productId: string;
  name: string;
  onSent: (remaining: number) => void;
  onInvalid: () => void;
  onAge: () => void;
}) {
  const [form, setForm] = useState<ReviewForm>(EMPTY_REVIEW);
  const [errors, setErrors] = useState<ReviewErrors>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = (field: ReviewField) => `${productId}-${field}`;
  const set = <K extends ReviewField>(field: K, value: ReviewForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const described = (field: ReviewField) =>
    errors[field] ? { "aria-invalid": true, "aria-describedby": `${id(field)}-error` } : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const request = reviewRequest(token, productId, form);
    if (!request.ok) {
      setErrors(request.errors);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const response = await send("", request.body);
      const outcome = submitOutcome(response.status, await response.json().catch(() => null));
      if (outcome.kind === "sent") return onSent(outcome.remaining);
      if (outcome.kind === "invalid") return onInvalid();
      if (outcome.kind === "age") return onAge();
      setProblem(
        outcome.kind === "rejected"
          ? "Your review couldn't be accepted as written. Check it and try again."
          : outcome.limited
            ? "Too many tries. Wait a minute and try again."
            : "Something went wrong on our side. Your review was not sent; try again.",
      );
    } catch {
      setProblem("We couldn't reach the store. Your review was not sent; try again.");
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field: ReviewField) =>
    errors[field] ? (
      <span id={`${id(field)}-error`} className="text-[13px] font-medium text-error">
        {errors[field]}
      </span>
    ) : null;

  return (
    <form
      onSubmit={submit}
      noValidate
      className={PANEL}
      aria-labelledby={id("rating") + "-product"}
    >
      <h2 id={id("rating") + "-product"} className="text-lg font-semibold">
        {name}
      </h2>
      <fieldset className="flex flex-col gap-1.5" {...described("rating")}>
        <legend className="text-[13px] font-medium">Your rating</legend>
        <div className="flex gap-1">
          {STAR_LABELS.map((label, index) => {
            const value = index + 1;
            return (
              <label
                key={value}
                className="flex size-11 cursor-pointer items-center justify-center rounded-md text-2xl has-focus-visible:outline-2 has-focus-visible:outline-focus"
                title={label}
              >
                <input
                  type="radio"
                  name={id("rating")}
                  value={value}
                  checked={form.rating === value}
                  onChange={() => set("rating", value)}
                  className="sr-only"
                />
                <span aria-hidden className={form.rating >= value ? "text-accent" : "text-line-2"}>
                  ★
                </span>
                <span className="sr-only">
                  {value} {value === 1 ? "star" : "stars"}, {label}
                </span>
              </label>
            );
          })}
        </div>
        {fieldError("rating")}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("title")} className="text-[13px] font-medium">
          Title
        </label>
        <input
          id={id("title")}
          className={INPUT}
          value={form.title}
          maxLength={REVIEW_TITLE_MAX}
          onChange={(event) => set("title", event.target.value)}
          {...described("title")}
        />
        {fieldError("title")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("body")} className="text-[13px] font-medium">
          Your review
        </label>
        <textarea
          id={id("body")}
          className={`${INPUT} min-h-[120px] resize-y`}
          value={form.body}
          maxLength={REVIEW_BODY_MAX}
          onChange={(event) => set("body", event.target.value)}
          {...described("body")}
        />
        {fieldError("body")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("authorName")} className="text-[13px] font-medium">
          Name to show
        </label>
        <input
          id={id("authorName")}
          className={INPUT}
          value={form.authorName}
          maxLength={REVIEW_AUTHOR_MAX}
          autoComplete="off"
          onChange={(event) => set("authorName", event.target.value)}
          {...described("authorName")}
        />
        <span className="text-xs text-ink-3">A first name or initials is enough.</span>
        {fieldError("authorName")}
      </div>
      {problem && (
        <p role="alert" className="text-sm font-medium text-error">
          {problem}
        </p>
      )}
      <button type="submit" className={PRIMARY} disabled={busy}>
        {busy ? "Sending…" : "Send review"}
      </button>
    </form>
  );
}
