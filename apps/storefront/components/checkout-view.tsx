"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useFreshCart } from "@/lib/cart/fresh";
import { clearCart } from "@/lib/cart/store";
import { currentAttempt, endAttempt } from "@/lib/checkout/attempt";
import { rememberedPlaced, rememberPlaced } from "@/lib/checkout/confirmation";
import { rememberChoice, rememberedChoice, type QuoteChoice } from "@/lib/checkout/memory";
import {
  EMPTY_FORM,
  ORDER_MESSAGES,
  orderOutcome,
  requestParts,
  serverFieldErrors,
  validateForm,
  type AddressType,
  type CheckoutForm,
  type FormErrors,
  type FormField,
} from "@/lib/checkout/order";
import { displayAed } from "@/lib/store/listing";
import { CartQuote, type AcceptedOrderQuote } from "./cart-quote";

const INPUT =
  "min-h-12 w-full rounded-md border border-line-2 bg-surface px-3.5 py-3 text-base hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-error aria-[invalid=true]:bg-error-soft";
const STEP = "flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 sm:p-6";
const PRIMARY =
  "inline-flex h-12 items-center justify-center rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60";
/** Fields in the order they appear, for the error summary. */
const FIELD_ORDER: readonly FormField[] = [
  "name",
  "phone",
  "type",
  "building",
  "unit",
  "street",
  "makani",
  "notes",
  "areaId",
  "ageConfirmed",
];
const FIELD_ID: Record<FormField, string> = {
  name: "checkout-name",
  phone: "checkout-phone",
  type: "checkout-type",
  building: "checkout-building",
  unit: "checkout-unit",
  street: "checkout-street",
  makani: "checkout-makani",
  notes: "checkout-notes",
  areaId: "checkout-area",
  ageConfirmed: "checkout-age",
};
const TYPES: ReadonlyArray<{
  type: AddressType;
  label: string;
  building: [label: string, placeholder: string];
  unit: [label: string, placeholder: string] | null;
}> = [
  {
    type: "apartment",
    label: "Apartment",
    building: ["Building name", "e.g. Marina Gate 2"],
    unit: ["Apartment no.", "e.g. 2408"],
  },
  {
    type: "villa",
    label: "Villa",
    building: ["Villa number & community", "e.g. Villa 24, Springs 7"],
    unit: null,
  },
  {
    type: "office",
    label: "Office / Hotel",
    building: ["Building or hotel name", "e.g. Marina Gate 2"],
    unit: ["Office / room no.", "e.g. 2408"],
  },
];

function StepHead({ n, children }: { n: number; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5 text-[17px] font-semibold">
      <span className="flex size-[26px] items-center justify-center rounded-full bg-ink font-mono text-xs text-surface">
        {n}
      </span>
      {children}
    </h2>
  );
}
function Field({
  id,
  label,
  optional,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  help?: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label} {optional && <span className="font-normal text-ink-3">(optional)</span>}
      </label>
      {children}
      {error ? (
        <span id={`${id}-error`} className="text-[13px] font-medium text-error">
          {error}
        </span>
      ) : (
        help && <span className="text-xs text-ink-3">{help}</span>
      )}
    </div>
  );
}

/**
 * Checkout form (roadmap step 80). Name, phone and address live in this component's state and
 * nowhere else: nothing typed here is written to device storage. The only thing kept on the
 * device is the random attempt key, so that pressing the button again, after a refresh or a
 * lost answer, can never place a second order. The total is the server's, accepted by the
 * shopper; the cart is emptied only once the API has acknowledged the order.
 */
export function CheckoutView() {
  const { cart, view, mounted, recheck } = useFreshCart();
  const [form, setForm] = useState<CheckoutForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [choice, setChoice] = useState<QuoteChoice>(rememberedChoice);
  const [accepted, setAccepted] = useState<AcceptedOrderQuote | null>(null);
  const [quoteReady, setQuoteReady] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set once the order is acknowledged, while the confirmation page is being opened.
  const [placed, setPlaced] = useState(false);
  const router = useRouter();
  const [alreadyPlaced, setAlreadyPlaced] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  // Blocks a second press while the first is on its way, before React has re-rendered.
  const sending = useRef(false);

  const onChoice = useCallback((next: QuoteChoice) => {
    rememberChoice(next);
    setChoice(next);
  }, []);
  const shown = FIELD_ORDER.filter((field) => errors[field]);
  useEffect(() => {
    if (shown.length) summary.current?.focus();
    // Only when a new set of errors is shown, not while they are being fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors]);

  const set = <K extends keyof CheckoutForm>(field: K, value: CheckoutForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) return current;
      const rest = { ...current };
      delete rest[field as FormField];
      return rest;
    });
  };
  const text = (field: Exclude<keyof CheckoutForm, "type" | "ageConfirmed">) => ({
    id: FIELD_ID[field],
    value: form[field],
    "aria-invalid": errors[field] ? (true as const) : undefined,
    "aria-describedby": errors[field] ? `${FIELD_ID[field]}-error` : undefined,
    onChange: (event: { target: { value: string } }) => set(field, event.target.value),
  });

  async function submit() {
    if (sending.current) return;
    const found = validateForm(form, choice.areaId);
    setErrors(found);
    setMessage(null);
    if (Object.keys(found).length) return;
    if (!accepted) {
      setMessage("Check your total and accept it before placing your order.");
      return;
    }
    const { contact, address } = requestParts(form, accepted.areaId);
    sending.current = true;
    setBusy(true);
    let outcome: ReturnType<typeof orderOutcome>;
    try {
      const response = await fetch("/api/v1/store/orders", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "idempotency-key": currentAttempt().key },
        body: JSON.stringify({
          contact,
          address,
          lines: accepted.lines,
          couponCode: accepted.couponCode,
          quoteToken: accepted.token,
          ageConfirmed: true,
        }),
      });
      outcome = orderOutcome(response.status, await response.json().catch(() => null));
    } catch {
      // No answer at all: the order may or may not exist. The key stays.
      outcome = { kind: "uncertain", reason: "NETWORK" };
    }
    sending.current = false;
    setBusy(false);
    switch (outcome.kind) {
      case "placed":
        // Acknowledged: only now is the attempt over and the cart emptied.
        endAttempt();
        clearCart();
        setForm(EMPTY_FORM);
        // The confirmation page reads the order with the cookie the API just set; nothing
        // goes in the URL. `replace`, so Back does not return to a form for a placed order.
        rememberPlaced(outcome.order);
        setPlaced(true);
        router.replace("/order-confirmation");
        return;
      case "already_placed":
        setAlreadyPlaced(true);
        return;
      case "invalid": {
        const fields = serverFieldErrors(outcome.fields, form, accepted.areaId);
        // The stored key itself was refused (damaged storage): nothing can have been placed
        // with it, so it is replaced. Otherwise a refusal that names no field of the form is
        // not something the shopper can fix by editing.
        if (outcome.fields.some((field) => field.path === "idempotencyKey")) endAttempt();
        setErrors(fields);
        setMessage(
          Object.keys(fields).length
            ? ORDER_MESSAGES.INVALID
            : `${ORDER_MESSAGES.UNAVAILABLE} ${ORDER_MESSAGES.SAFE_RETRY}`,
        );
        return;
      }
      case "requote":
        setRefresh((count) => count + 1);
        if (outcome.reason === "INSUFFICIENT_STOCK") recheck();
        setMessage(ORDER_MESSAGES[outcome.reason]);
        return;
      case "blocked":
        if (outcome.reason === "AREA_UNAVAILABLE")
          setErrors({ areaId: ORDER_MESSAGES.AREA_UNAVAILABLE });
        if (outcome.reason === "VARIANT_UNAVAILABLE") recheck();
        setMessage(ORDER_MESSAGES[outcome.reason]);
        return;
      case "uncertain":
        setMessage(`${ORDER_MESSAGES[outcome.reason]} ${ORDER_MESSAGES.SAFE_RETRY}`);
    }
  }

  if (!mounted)
    return (
      <p role="status" className="py-9 text-sm text-ink-2">
        Loading checkout…
      </p>
    );
  if (placed) {
    // Normally replaced by the confirmation page at once. If that page cannot be opened (the
    // connection dropped), the shopper still has the order number and a way to it.
    const order = rememberedPlaced();
    return (
      <div role="status" className="flex flex-col items-start gap-3 py-9 text-sm text-ink-2">
        <p>
          Order placed
          {order && (
            <>
              : <b className="font-mono font-semibold text-ink">{order.orderNumber}</b> ·{" "}
              {displayAed(order.totalFils)} cash on delivery
            </>
          )}
          . Opening your confirmation…
        </p>
        <Link href="/order-confirmation" prefetch={false} className="underline underline-offset-2">
          View your order
        </Link>
      </div>
    );
  }
  if (alreadyPlaced)
    return (
      <section
        role="alert"
        className="mx-auto flex max-w-lg flex-col gap-3 rounded-lg border border-line bg-surface p-6"
      >
        <h2 className="text-xl font-semibold">This order was already placed</h2>
        <p className="text-sm text-ink-2">
          An order was already placed from this checkout, so we did not place it again. Your items
          are on their way to being confirmed; you do not need to do anything.
        </p>
        <p className="text-sm text-ink-2">
          Your cart still shows them. Only continue if you want a second, separate order.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/order-confirmation" prefetch={false} className={PRIMARY}>
            View your latest order
          </Link>
          <button
            type="button"
            className="inline-flex h-11 items-center rounded-pill border border-line px-4 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            onClick={() => {
              // The shopper asks for another order: this, and only this, makes a new key.
              endAttempt();
              setAlreadyPlaced(false);
              setMessage(null);
            }}
          >
            Place a second order
          </button>
          <Link href="/cart" prefetch={false} className="self-center text-sm underline">
            Back to cart
          </Link>
        </div>
      </section>
    );
  if (cart.lines.length === 0)
    return (
      <div className="flex flex-col items-center gap-3.5 px-2 py-9 text-center">
        <h2 className="text-lg font-semibold">Your cart is empty</h2>
        <p className="max-w-sm text-sm text-ink-2">Add something before checking out.</p>
        <Link href="/shop" prefetch={false} className={PRIMARY}>
          Shop now
        </Link>
      </div>
    );

  const buyable = view.lines.filter(
    (line) => line.status === "ok" || line.status === "unconfirmed",
  );
  const quoteLines = buyable.map(({ variantId, quantity, name }) => ({
    variantId,
    quantity,
    name,
  }));
  const kind = TYPES.find((item) => item.type === form.type)!;
  const total = accepted ? displayAed(accepted.totalFils) : null;
  return (
    <div className="grid gap-5 pb-14 lg:grid-cols-[1.35fr_1fr] lg:items-start lg:gap-10">
      <div className="flex flex-col gap-4">
        {shown.length > 0 && (
          <div
            ref={summary}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-error bg-error-soft p-4 text-sm focus-visible:outline-2 focus-visible:outline-error"
          >
            <p className="font-semibold">
              Please fix {shown.length} {shown.length === 1 ? "thing" : "things"} to place your
              order:
            </p>
            <ul className="list-disc pl-5">
              {shown.map((field) => (
                <li key={field}>
                  <a href={`#${FIELD_ID[field]}`} className="underline underline-offset-2">
                    {errors[field]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <form
          id="checkout-form"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <section className={STEP}>
            <StepHead n={1}>Contact</StepHead>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={FIELD_ID.name} label="Full name" error={errors.name}>
                <input {...text("name")} className={INPUT} autoComplete="name" maxLength={100} />
              </Field>
              <Field
                id={FIELD_ID.phone}
                label="Mobile number"
                help="For delivery updates on WhatsApp or by call"
                error={errors.phone}
              >
                <div className="flex">
                  <span className="flex items-center rounded-l-md border border-r-0 border-line-2 bg-surface-2 px-3 text-base text-ink-2">
                    +971
                  </span>
                  <input
                    {...text("phone")}
                    className={`${INPUT} rounded-l-none`}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    placeholder="50 123 4567"
                    maxLength={20}
                  />
                </div>
              </Field>
            </div>
          </section>
          <section className={STEP}>
            <StepHead n={2}>Delivery address</StepHead>
            <fieldset id={FIELD_ID.type} className="flex flex-col gap-1.5">
              <legend className="pb-1.5 text-[13px] font-medium">Address type</legend>
              <div className="grid grid-cols-3 gap-2">
                {TYPES.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    aria-pressed={form.type === item.type}
                    onClick={() => set("type", item.type)}
                    className="min-h-12 rounded-md border border-line-2 px-2 text-sm font-medium hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:border-ink aria-pressed:bg-bg aria-pressed:shadow-[inset_0_0_0_1px_var(--color-ink)]"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={FIELD_ID.building} label={kind.building[0]} error={errors.building}>
                <input
                  {...text("building")}
                  className={INPUT}
                  autoComplete="address-line1"
                  placeholder={kind.building[1]}
                  maxLength={150}
                />
              </Field>
              {kind.unit && (
                <Field id={FIELD_ID.unit} label={kind.unit[0]} error={errors.unit}>
                  <input
                    {...text("unit")}
                    className={INPUT}
                    autoComplete="address-line2"
                    placeholder={kind.unit[1]}
                    maxLength={50}
                  />
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={FIELD_ID.street} label="Street or landmark" optional error={errors.street}>
                <input
                  {...text("street")}
                  className={INPUT}
                  placeholder="e.g. next to Spinneys"
                  maxLength={150}
                />
              </Field>
              <Field
                id={FIELD_ID.makani}
                label="Makani number"
                optional
                help="On the blue plate at your building entrance"
                error={errors.makani}
              >
                <input
                  {...text("makani")}
                  className={`${INPUT} font-mono`}
                  inputMode="numeric"
                  placeholder="10 digits"
                  maxLength={14}
                />
              </Field>
            </div>
            <Field id={FIELD_ID.notes} label="Delivery notes" optional error={errors.notes}>
              <textarea
                {...text("notes")}
                className={`${INPUT} min-h-[84px] resize-y`}
                placeholder="Gate code, best time to call, leave with reception…"
                maxLength={500}
              />
            </Field>
          </section>
        </form>
        {/* Outside the form above: this block has its own small form for the discount code. */}
        <section className={STEP}>
          <StepHead n={3}>Delivery area and total</StepHead>
          {view.blockedCount > 0 && (
            <p className="text-sm font-medium text-error">
              Something in your cart can no longer be bought.{" "}
              <Link href="/cart" prefetch={false} className="underline underline-offset-2">
                Go back to your cart
              </Link>{" "}
              to remove it.
            </p>
          )}
          <CartQuote
            lines={quoteLines}
            blocked={view.blockedCount}
            onUnavailable={recheck}
            onReady={setQuoteReady}
            initial={choice}
            onChoice={onChoice}
            onAccepted={setAccepted}
            refresh={refresh}
            areaError={errors.areaId}
          />
        </section>
        <section className={STEP}>
          <StepHead n={4}>Payment</StepHead>
          <div className="rounded-md border-[1.5px] border-ink bg-bg p-4 text-sm">
            <b className="font-semibold">Cash on delivery</b>
            <p className="text-ink-2">
              {total
                ? `Pay ${total} in cash when your order arrives. Exact change helps.`
                : "Pay in cash when your order arrives. Exact change helps."}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-start gap-3 text-[14.5px]">
              <input
                id={FIELD_ID.ageConfirmed}
                form="checkout-form"
                type="checkbox"
                className="mt-0.5 size-[22px] shrink-0 accent-ink"
                checked={form.ageConfirmed}
                aria-invalid={errors.ageConfirmed ? true : undefined}
                aria-describedby={
                  errors.ageConfirmed ? `${FIELD_ID.ageConfirmed}-error` : undefined
                }
                onChange={(event) => set("ageConfirmed", event.target.checked)}
              />
              I confirm I am 18 or older.
            </label>
            {errors.ageConfirmed && (
              <span
                id={`${FIELD_ID.ageConfirmed}-error`}
                className="text-[13px] font-medium text-error"
              >
                {errors.ageConfirmed}
              </span>
            )}
          </div>
          {message && (
            <p role="alert" className="text-sm font-medium text-error">
              {message}
            </p>
          )}
          <button type="submit" form="checkout-form" disabled={busy} className={PRIMARY}>
            {busy ? "Placing your order…" : total ? `Place order · ${total}` : "Place order"}
          </button>
          <p role="status" aria-live="polite" className="text-center text-xs text-ink-3">
            {busy
              ? "Please wait. Do not close this page."
              : quoteReady || choice.areaId
                ? ""
                : "Choose your delivery area to see your total."}
          </p>
          <p className="text-center text-xs text-ink-3">
            By placing your order you agree to our{" "}
            <Link href="/terms" prefetch={false} className="underline underline-offset-2">
              terms
            </Link>
            .
          </p>
        </section>
      </div>
      <aside
        aria-label="Order summary"
        className="order-first flex h-fit flex-col gap-3 rounded-lg border border-line bg-surface p-5 lg:sticky lg:top-6 lg:order-none"
      >
        <h2 className="text-lg font-semibold">Order summary</h2>
        <ul className="flex flex-col gap-3 text-sm">
          {buyable.map((line) => (
            <li key={line.variantId} className="flex justify-between gap-4">
              <span>
                <span className="font-medium">{line.name}</span>
                <span className="block text-xs text-ink-3">
                  {[line.options, `Qty ${line.quantity}`].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="whitespace-nowrap">{displayAed(line.lineTotalFils)}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-between gap-4 border-t border-line pt-3 text-sm">
          <span>
            Subtotal ({view.itemCount} {view.itemCount === 1 ? "item" : "items"})
          </span>
          <span className="font-semibold">{displayAed(view.subtotalFils)}</span>
        </div>
        <Link href="/cart" prefetch={false} className="text-sm underline underline-offset-2">
          Edit cart
        </Link>
      </aside>
    </div>
  );
}
