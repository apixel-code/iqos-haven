import { z } from "zod";
import {
  mergeOrderLines,
  normalizeCustomerName,
  normalizePhone,
  normalizeTextLine,
  toAsciiDigits,
  ORDER_LIMITS,
  OrderLinesError,
} from "@ih/domain";
import { customerAddressTypeSchema, type CustomerAddressType } from "./customers";

export { ORDER_LIMITS } from "@ih/domain";

/**
 * Checkout input (roadmap step 66): the one set of rules the storefront form and the API both
 * apply. Each schema takes what was typed and returns the normalized value that is stored and
 * hashed, or issues whose `path` is the field and whose `message` can be shown as is.
 */
export const CHECKOUT_MESSAGES = {
  name: "Enter your full name",
  phoneMissing: "Enter your mobile number",
  phone: "Enter a UAE mobile number, e.g. 50 123 4567",
  area: "Select your area",
  type: "Choose apartment, villa or office",
  building: {
    apartment: "Enter your building name",
    office: "Enter your building name",
    villa: "Enter your villa number and community",
  },
  unit: {
    apartment: "Enter your apartment number",
    office: "Enter your office or room number",
  },
  makani: "Makani numbers have 10 digits, or leave this blank",
  characters: "Remove symbols that cannot be shown",
  tooLong: (max: number) => `Use ${max} characters or fewer`,
  linesEmpty: "Your cart is empty",
  linesTooMany: `An order can hold up to ${ORDER_LIMITS.maxLines} different items`,
  quantity: `You can order up to ${ORDER_LIMITS.maxLineQuantity} of one item`,
} as const;
export const CHECKOUT_BOUNDS = { name: 100, building: 150, unit: 50, street: 150, notes: 500 };
/** Typed text is bounded before any work is done on it. */
const typed = z.string().max(2000);
type Issues = { addIssue(issue: { code: "custom"; message: string; path: string[] }): void };
/** Normalized line or `null`; reports unsupported characters and length, returns `undefined`. */
function line(ctx: Issues, field: string, value: string | null | undefined, max: number) {
  let text: string | null;
  try {
    text = normalizeTextLine(value);
  } catch {
    ctx.addIssue({ code: "custom", message: CHECKOUT_MESSAGES.characters, path: [field] });
    return undefined;
  }
  if (text && text.length > max) {
    ctx.addIssue({ code: "custom", message: CHECKOUT_MESSAGES.tooLong(max), path: [field] });
    return undefined;
  }
  return text;
}

export const checkoutContactSchema = z
  .strictObject({
    name: typed.optional().default(""),
    phone: typed.optional().default(""),
  })
  .transform((value, ctx) => {
    let name: string | undefined;
    try {
      name = normalizeCustomerName(value.name);
    } catch {
      name = undefined;
    }
    if (!name || name.length < 2)
      ctx.addIssue({ code: "custom", message: CHECKOUT_MESSAGES.name, path: ["name"] });
    let phone: string | undefined;
    try {
      phone = normalizePhone(value.phone);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: /\d/u.test(value.phone) ? CHECKOUT_MESSAGES.phone : CHECKOUT_MESSAGES.phoneMissing,
        path: ["phone"],
      });
    }
    if (!name || name.length < 2 || !phone) return z.NEVER;
    return { name, phone };
  });
export type CheckoutContact = z.output<typeof checkoutContactSchema>;

const areaId = z.uuid();
/** Every field is checked in one pass so a form can show all its messages together. */
export const checkoutAddressSchema = z
  .strictObject({
    areaId: typed.nullish(),
    type: typed.nullish(),
    building: typed.nullish(),
    unit: typed.nullish(),
    street: typed.nullish(),
    makani: typed.nullish(),
    notes: typed.nullish(),
  })
  .transform((value, ctx) => {
    let ok = true;
    const issues: Issues = {
      addIssue(issue) {
        ok = false;
        ctx.addIssue(issue);
      },
    };
    const report = (field: string, message: string) =>
      issues.addIssue({ code: "custom", message, path: [field] });
    const area = areaId.safeParse(value.areaId);
    if (!area.success) report("areaId", CHECKOUT_MESSAGES.area);
    const kind = customerAddressTypeSchema.safeParse(value.type);
    if (!kind.success) report("type", CHECKOUT_MESSAGES.type);
    // Without a valid type the wording of the next two messages falls back to the apartment one.
    const type: CustomerAddressType = kind.success ? kind.data : "apartment";
    const building = line(issues, "building", value.building, CHECKOUT_BOUNDS.building);
    const unit = line(issues, "unit", value.unit, CHECKOUT_BOUNDS.unit);
    const street = line(issues, "street", value.street, CHECKOUT_BOUNDS.street);
    const notes = line(issues, "notes", value.notes, CHECKOUT_BOUNDS.notes);
    const makani = toAsciiDigits(value.makani ?? "").replace(/\s/gu, "") || null;
    if (building === null) report("building", CHECKOUT_MESSAGES.building[type]);
    if (unit === null && type !== "villa") report("unit", CHECKOUT_MESSAGES.unit[type]);
    if (makani !== null && !/^[0-9]{10}$/.test(makani)) report("makani", CHECKOUT_MESSAGES.makani);
    if (!ok || !area.success || !building || unit === undefined) return z.NEVER;
    if (street === undefined || notes === undefined) return z.NEVER;
    return { areaId: area.data.toLowerCase(), type, building, unit, street, makani, notes };
  });
export type CheckoutAddress = z.output<typeof checkoutAddressSchema>;

const problems = {
  EMPTY: CHECKOUT_MESSAGES.linesEmpty,
  TOO_MANY_LINES: CHECKOUT_MESSAGES.linesTooMany,
  QUANTITY: CHECKOUT_MESSAGES.quantity,
} as const;
/** Lines of a quote or order: merged per variant, capped and in variant-ID order. */
export const orderLinesSchema = z
  .array(
    z.strictObject({
      variantId: z.uuid(),
      quantity: z.number({ error: CHECKOUT_MESSAGES.quantity }),
    }),
    { error: CHECKOUT_MESSAGES.linesEmpty },
  )
  .max(ORDER_LIMITS.maxLines, { error: CHECKOUT_MESSAGES.linesTooMany })
  .transform((lines, ctx) => {
    try {
      return mergeOrderLines(lines);
    } catch (error) {
      if (!(error instanceof OrderLinesError)) throw error;
      const index = lines.findIndex((item) => item.variantId.toLowerCase() === error.variantId);
      ctx.addIssue({
        code: "custom",
        message: problems[error.problem],
        path: index < 0 ? [] : [index, "quantity"],
      });
      return z.NEVER;
    }
  });
export type OrderLines = z.output<typeof orderLinesSchema>;
