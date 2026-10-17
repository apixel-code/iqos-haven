import {
  CHECKOUT_MESSAGES,
  checkoutAddressSchema,
  checkoutContactSchema,
  storeOrderResponseSchema,
  type StoreOrderResponse,
} from "@ih/contracts";

/**
 * Placing the order from the checkout form (roadmap step 80, ADR 0046). This module holds the
 * decisions around the request, free of React and of the network: what the form may send, and
 * what each answer means for the attempt key and for what the shopper is told.
 */
export type AddressType = "apartment" | "villa" | "office";
export interface CheckoutForm {
  name: string;
  phone: string;
  type: AddressType;
  building: string;
  unit: string;
  street: string;
  makani: string;
  notes: string;
  ageConfirmed: boolean;
}
export const EMPTY_FORM: CheckoutForm = {
  name: "",
  phone: "",
  type: "apartment",
  building: "",
  unit: "",
  street: "",
  makani: "",
  notes: "",
  ageConfirmed: false,
};
export type FormField = keyof Omit<CheckoutForm, "type"> | "areaId" | "type";
export type FormErrors = Partial<Record<FormField, string>>;
export const AGE_MESSAGE = "Confirm you are 18 or older";

/** The request parts built from the form, as typed; the API normalizes them the same way. */
export function requestParts(form: CheckoutForm, areaId: string) {
  return {
    contact: { name: form.name, phone: form.phone },
    address: {
      areaId: areaId || null,
      type: form.type,
      building: form.building,
      // A villa has no unit; whatever was typed before switching type is not sent.
      unit: form.type === "villa" ? null : form.unit,
      street: form.street,
      makani: form.makani,
      notes: form.notes,
    },
  };
}
/** Every message at once, from the same rules the API applies (ADR 0035). */
export function validateForm(form: CheckoutForm, areaId: string): FormErrors {
  const errors: FormErrors = {};
  const { contact, address } = requestParts(form, areaId);
  const add = (field: unknown, message: string) => {
    if (typeof field === "string" && !(field in errors)) errors[field as FormField] = message;
  };
  const who = checkoutContactSchema.safeParse(contact);
  if (!who.success) for (const issue of who.error.issues) add(issue.path[0], issue.message);
  const where = checkoutAddressSchema.safeParse(address);
  if (!where.success) for (const issue of where.error.issues) add(issue.path[0], issue.message);
  if (!form.ageConfirmed) errors.ageConfirmed = AGE_MESSAGE;
  return errors;
}
const FALLBACK = "Check this field";
const FIELD_OF_PATH: Record<string, FormField> = {
  "contact.name": "name",
  "contact.phone": "phone",
  "address.areaId": "areaId",
  "address.type": "type",
  "address.building": "building",
  "address.unit": "unit",
  "address.street": "street",
  "address.makani": "makani",
  "address.notes": "notes",
  ageConfirmed: "ageConfirmed",
};
/**
 * The API names fields, never what was typed and never a message. A field it refuses that the
 * form's own check passed gets a general hint; the form's own message wins where there is one.
 */
export function serverFieldErrors(
  fields: ReadonlyArray<{ path: string }>,
  form: CheckoutForm,
  areaId: string,
): FormErrors {
  const own = validateForm(form, areaId);
  const errors: FormErrors = {};
  for (const { path } of fields) {
    const field = FIELD_OF_PATH[path];
    if (field)
      errors[field] = own[field] ?? (field === "phone" ? CHECKOUT_MESSAGES.phone : FALLBACK);
  }
  return errors;
}

export type OrderOutcome =
  /** Acknowledged: the order exists. End the attempt and empty the cart. */
  | { kind: "placed"; order: StoreOrderResponse }
  /** Nothing was placed and the form must change. The key is kept. */
  | { kind: "invalid"; fields: ReadonlyArray<{ path: string }> }
  /** Nothing was placed; the total, stock or code must be looked at again. The key is kept. */
  | { kind: "requote"; reason: RequoteReason }
  /** Nothing was placed and it cannot be from here. The key is kept. */
  | { kind: "blocked"; reason: "AREA_UNAVAILABLE" | "VARIANT_UNAVAILABLE" | "AGE" }
  /** Unknown whether it was placed. Try the same key again; never a new one. */
  | { kind: "uncertain"; reason: "BUSY" | "LIMITED" | "UNAVAILABLE" | "NETWORK" }
  /** An order was already made with this key. Never submitted again as new. */
  | { kind: "already_placed" };
export type RequoteReason =
  | "QUOTE_CHANGED"
  | "QUOTE_EXPIRED"
  | "INSUFFICIENT_STOCK"
  | "COUPON_INVALID"
  | "COUPON_LIMIT_REACHED";
const REQUOTE: readonly string[] = [
  "QUOTE_CHANGED",
  "QUOTE_EXPIRED",
  "INSUFFICIENT_STOCK",
  "COUPON_INVALID",
  "COUPON_LIMIT_REACHED",
];
/**
 * What an answer of the order route means. `body` is the parsed JSON or null. Anything not
 * recognised is `uncertain`: the safe reading, because the same key can always be sent again.
 */
export function orderOutcome(status: number, body: unknown): OrderOutcome {
  if (status === 201) {
    const order = storeOrderResponseSchema.safeParse(body);
    // An acknowledgement that cannot be read is still not a reason to make a second order.
    return order.success
      ? { kind: "placed", order: order.data }
      : { kind: "uncertain", reason: "UNAVAILABLE" };
  }
  const error =
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object"
      ? (body.error as { code?: unknown; fields?: unknown })
      : {};
  const code = typeof error.code === "string" ? error.code : "";
  if (status === 400) {
    const fields = Array.isArray(error.fields)
      ? error.fields.filter(
          (field): field is { path: string } =>
            !!field && typeof (field as { path?: unknown }).path === "string",
        )
      : [];
    return { kind: "invalid", fields };
  }
  if (status === 403) return { kind: "blocked", reason: "AGE" };
  if (status === 429) return { kind: "uncertain", reason: "LIMITED" };
  if (status === 409) {
    if (code === "IDEMPOTENCY_CONFLICT" || code === "CHECKOUT_RECOVERY_REQUIRED")
      return { kind: "already_placed" };
    if (code === "IDEMPOTENCY_IN_PROGRESS") return { kind: "uncertain", reason: "BUSY" };
    if (REQUOTE.includes(code)) return { kind: "requote", reason: code as RequoteReason };
    if (code === "AREA_UNAVAILABLE" || code === "VARIANT_UNAVAILABLE")
      return { kind: "blocked", reason: code };
  }
  return { kind: "uncertain", reason: "UNAVAILABLE" };
}
export const ORDER_MESSAGES = {
  QUOTE_CHANGED: "Your total changed. Check the new total and accept it, then place your order.",
  QUOTE_EXPIRED: "Your total was shown a while ago. We have checked it again; place your order.",
  INSUFFICIENT_STOCK: "Something in your cart just sold out. Go back to your cart to change it.",
  COUPON_INVALID: "That code can't be used on this order. Check your total without it.",
  COUPON_LIMIT_REACHED: "That code has been fully used. Check your total without it.",
  AREA_UNAVAILABLE: "We can't deliver to that area right now. Choose another area.",
  VARIANT_UNAVAILABLE: "Something in your cart is no longer available. Go back to your cart.",
  AGE: "Your age confirmation has expired. Reload the page to continue.",
  BUSY: "We are still placing your order. Press the button again in a moment.",
  LIMITED: "Too many tries. Wait a minute, then press the button again.",
  UNAVAILABLE: "We couldn't confirm your order just now. Press the button again.",
  NETWORK: "We couldn't reach the shop. Check your connection and press the button again.",
  /** Shown with every uncertain answer. */
  SAFE_RETRY: "Pressing again will not order twice.",
  INVALID: "Some details need another look.",
} as const;
