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
import { CartQuote, type AcceptedOrderQuote } from "./cart-quote";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

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
  icon: "building" | "home" | "briefcase";
  building: [label: string, placeholder: string];
  unit: [label: string, placeholder: string] | null;
}> = [
  {
    type: "apartment",
    label: "Apartment",
    icon: "building",
    building: ["Building name", "e.g. Marina Gate 2"],
    unit: ["Apartment no.", "e.g. 2408"],
  },
  {
    type: "villa",
    label: "Villa",
    icon: "home",
    building: ["Villa number & community", "e.g. Villa 24, Springs 7"],
    unit: null,
  },
  {
    type: "office",
    label: "Office / Hotel",
    icon: "briefcase",
    building: ["Building or hotel name", "e.g. Marina Gate 2"],
    unit: ["Office / room no.", "e.g. 2408"],
  },
];

/** The prototype's numbered step heading (`co-step h2 .n`). */
function StepHead({ n, children }: { n: number; children: ReactNode }) {
  return (
    <h2>
      <span className="n" aria-hidden="true">
        {n}
      </span>
      {children}
    </h2>
  );
}
/** The prototype's `fld`: label, control, then the error or the help line. */
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
    <div className="field">
      <label htmlFor={id} className="label">
        {label} {optional && <span className="opt">(optional)</span>}
      </label>
      {children}
      {error ? (
        <span id={`${id}-error`} className="errmsg">
          <Icon name="info" size="sm" />
          {error}
        </span>
      ) : (
        help && (
          <span id={`${id}-help`} className="help">
            {help}
          </span>
        )
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
  const { cart, view, images, mounted, recheck } = useFreshCart();
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
    className: errors[field] ? "input err" : "input",
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
      <p role="status" className="small muted co-wait">
        Loading checkout…
      </p>
    );
  if (placed) {
    // Normally replaced by the confirmation page at once. If that page cannot be opened (the
    // connection dropped), the shopper still has the order number and a way to it.
    const order = rememberedPlaced();
    return (
      <div role="status" className="co-wait">
        <p className="muted">
          Order placed
          {order && (
            <>
              : <b className="mono ink">{order.orderNumber}</b> · <Money fils={order.totalFils} />{" "}
              cash on delivery
            </>
          )}
          . Opening your confirmation…
        </p>
        <Link href="/order-confirmation" prefetch={false} className="link">
          View your order
        </Link>
      </div>
    );
  }
  if (alreadyPlaced)
    return (
      <section role="alert" className="panel co-again">
        <h2 className="h3">This order was already placed</h2>
        <p className="muted">
          An order was already placed from this checkout, so we did not place it again. Your items
          are on their way to being confirmed; you do not need to do anything.
        </p>
        <p className="muted">
          Your cart still shows them. Only continue if you want a second, separate order.
        </p>
        <div className="co-actions">
          <Link href="/order-confirmation" prefetch={false} className="btn btn-primary">
            View your latest order
          </Link>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              // The shopper asks for another order: this, and only this, makes a new key.
              endAttempt();
              setAlreadyPlaced(false);
              setMessage(null);
            }}
          >
            Place a second order
          </button>
          <Link href="/cart" prefetch={false} className="link small">
            Back to cart
          </Link>
        </div>
      </section>
    );
  if (cart.lines.length === 0)
    return (
      <div className="done">
        <div className="empty">
          <span className="ic">
            <Icon name="bag" size="lg" />
          </span>
          <h2 className="h3">Your cart is empty</h2>
          <p>Add something before checking out.</p>
          <Link href="/shop" prefetch={false} className="btn btn-primary">
            Shop now
          </Link>
        </div>
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
  const total = accepted ? <Money fils={accepted.totalFils} /> : null;
  // The prototype's summary lines (`mini-line`), on phones in the collapsed block (G-S8) and
  // beside the form from 900 px.
  const summaryBody = (
    <>
      <ul className="mini-lines">
        {buyable.map((line) => {
          const image = images.get(line.variantId);
          return (
            <li key={line.variantId} className="mini-line">
              <span className="th">
                {image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.urls.thumb} alt="" width={52} height={60} />
                )}
                <span className="q" aria-label={`Quantity ${line.quantity}`}>
                  {line.quantity}
                </span>
              </span>
              <span>
                <b className="nm">{line.name}</b>
                {line.options && (
                  <>
                    <br />
                    <span className="v">{line.options}</span>
                  </>
                )}
              </span>
              <span className="num">
                <Money fils={line.lineTotalFils} />
              </span>
            </li>
          );
        })}
      </ul>
      <dl className="totals">
        <div>
          <dt>
            Subtotal ({view.itemCount} {view.itemCount === 1 ? "item" : "items"})
          </dt>
          <dd>
            <Money fils={view.subtotalFils} />
          </dd>
        </div>
      </dl>
      <Link href="/cart" prefetch={false} className="link small">
        Edit cart
      </Link>
    </>
  );
  return (
    <div className="co">
      <div className="co-main">
        {/* Phones: the summary folds away with the amount in its title (parity G-S8). The
            amount is the accepted total once there is one, until then the subtotal. */}
        <details className="sumdet co-sum-m">
          <summary>
            <span>
              Order summary ·{" "}
              <b className="num">
                {accepted ? (
                  <Money fils={accepted.totalFils} />
                ) : (
                  <Money fils={view.subtotalFils} />
                )}
              </b>
              {!accepted && <span className="sr"> subtotal, before delivery</span>}
            </span>
            <Icon name="chev-d" />
          </summary>
          <div className="in">{summaryBody}</div>
        </details>
        {shown.length > 0 && (
          <div ref={summary} role="alert" tabIndex={-1} className="errsum">
            <b>
              Please fix {shown.length} {shown.length === 1 ? "thing" : "things"} to place your
              order:
            </b>
            <ul>
              {shown.map((field) => (
                <li key={field}>
                  <a href={`#${FIELD_ID[field]}`}>{errors[field]}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <form
          id="checkout-form"
          noValidate
          className="co-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <section className="co-step">
            <StepHead n={1}>Contact</StepHead>
            <div className="grid2">
              <Field id={FIELD_ID.name} label="Full name" error={errors.name}>
                <input {...text("name")} autoComplete="name" maxLength={100} />
              </Field>
              <Field
                id={FIELD_ID.phone}
                label="Mobile number"
                help="For delivery updates on WhatsApp or by call"
                error={errors.phone}
              >
                <div className="prefix">
                  <span aria-hidden="true">+971</span>
                  <input
                    {...text("phone")}
                    aria-describedby={
                      errors.phone ? `${FIELD_ID.phone}-error` : `${FIELD_ID.phone}-help`
                    }
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
          <section className="co-step">
            <StepHead n={2}>Delivery address</StepHead>
            <fieldset id={FIELD_ID.type} className="opt-g">
              <legend className="label">Address type</legend>
              <div className="atype">
                {TYPES.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    aria-pressed={form.type === item.type}
                    onClick={() => set("type", item.type)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid2">
              <Field id={FIELD_ID.building} label={kind.building[0]} error={errors.building}>
                <input
                  {...text("building")}
                  autoComplete="address-line1"
                  placeholder={kind.building[1]}
                  maxLength={150}
                />
              </Field>
              {kind.unit && (
                <Field id={FIELD_ID.unit} label={kind.unit[0]} error={errors.unit}>
                  <input
                    {...text("unit")}
                    autoComplete="address-line2"
                    placeholder={kind.unit[1]}
                    maxLength={50}
                  />
                </Field>
              )}
            </div>
            <div className="grid2">
              <Field id={FIELD_ID.street} label="Street or landmark" optional error={errors.street}>
                <input {...text("street")} placeholder="e.g. next to Spinneys" maxLength={150} />
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
                  className={errors.makani ? "input mono err" : "input mono"}
                  aria-describedby={
                    errors.makani ? `${FIELD_ID.makani}-error` : `${FIELD_ID.makani}-help`
                  }
                  inputMode="numeric"
                  placeholder="10 digits"
                  maxLength={14}
                />
              </Field>
            </div>
            <Field id={FIELD_ID.notes} label="Delivery notes" optional error={errors.notes}>
              <textarea
                {...text("notes")}
                className={errors.notes ? "textarea err" : "textarea"}
                placeholder="Gate code, best time to call, leave with reception…"
                maxLength={500}
              />
            </Field>
          </section>
        </form>
        {/* Outside the form above: this block has its own small form for the discount code. */}
        <section className="co-step">
          <StepHead n={3}>Delivery area and total</StepHead>
          {view.blockedCount > 0 && (
            <p className="errmsg">
              <Icon name="info" size="sm" />
              <span>
                Something in your cart can no longer be bought.{" "}
                <Link href="/cart" prefetch={false} className="link">
                  Go back to your cart
                </Link>{" "}
                to remove it.
              </span>
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
        <section className="co-step">
          <StepHead n={4}>Payment</StepHead>
          <div className="pay-opt">
            <Icon name="cash" size="lg" />
            <span className="pay-t">
              <b>Cash on delivery</b>
              <span className="small muted">
                {total ? (
                  <>
                    Pay <b className="num ink">{total}</b> in cash when your order arrives. Exact
                    change helps.
                  </>
                ) : (
                  "Pay in cash when your order arrives. Exact change helps."
                )}
              </span>
            </span>
            <span className="pay-ok">
              <Icon name="check" />
            </span>
          </div>
          <div className="field">
            <label className="check" htmlFor={FIELD_ID.ageConfirmed}>
              <input
                id={FIELD_ID.ageConfirmed}
                form="checkout-form"
                type="checkbox"
                className={errors.ageConfirmed ? "err" : undefined}
                checked={form.ageConfirmed}
                aria-invalid={errors.ageConfirmed ? true : undefined}
                aria-describedby={
                  errors.ageConfirmed ? `${FIELD_ID.ageConfirmed}-error` : undefined
                }
                onChange={(event) => set("ageConfirmed", event.target.checked)}
              />
              <span className="ct">I confirm I am 18 or older.</span>
            </label>
            {errors.ageConfirmed && (
              <span id={`${FIELD_ID.ageConfirmed}-error`} className="errmsg">
                <Icon name="info" size="sm" />
                {errors.ageConfirmed}
              </span>
            )}
          </div>
          {message && (
            <p role="alert" className="errmsg">
              <Icon name="info" size="sm" />
              {message}
            </p>
          )}
          <button
            type="submit"
            form="checkout-form"
            disabled={busy}
            className={
              busy ? "btn btn-primary btn-lg btn-block busy" : "btn btn-primary btn-lg btn-block"
            }
          >
            {busy ? "Placing your order…" : total ? <>Place order · {total}</> : "Place order"}
          </button>
          <p role="status" aria-live="polite" className="small muted center">
            {busy
              ? "Please wait. Do not close this page."
              : quoteReady || choice.areaId
                ? ""
                : "Choose your delivery area to see your total."}
          </p>
          <p className="small muted center">
            By placing your order you agree to our{" "}
            <Link href="/terms" prefetch={false} className="link">
              terms
            </Link>
            .
          </p>
        </section>
      </div>
      <aside aria-label="Order summary" className="panel sticky co-sum-d">
        <h2 className="h3">Order summary</h2>
        {summaryBody}
      </aside>
    </div>
  );
}
