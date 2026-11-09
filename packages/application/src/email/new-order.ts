import { z } from "zod";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@ih/domain";
import { brandedEmail, factsTable } from "./layout";
import type { EmailTemplate } from "./template";

const money = z.string().min(1).max(40);
const schema = z.strictObject({
  orderNumber: z.string().min(1).max(32),
  /** Already formatted from integer fils, e.g. "AED 212.99". */
  total: money,
  units: z.number().int().min(1),
  areaName: z.string().min(1).max(100),
  /** How the customer chose to pay (ADR 0111). */
  paymentMethod: z.enum(PAYMENT_METHODS),
  customer: z.strictObject({
    name: z.string().min(1).max(100),
    /** E.164, e.g. +971501234567. */
    phone: z.string().min(1).max(20),
    /** Null for a staff-entered order taken without one. */
    email: z.string().max(254).nullable(),
  }),
  /** "TEREA UAE · silver × 2" and its formatted line total. */
  items: z
    .array(z.strictObject({ label: z.string().min(1).max(400), total: money }))
    .min(1)
    .max(100),
});
/**
 * Tells the shop a new order arrived (step 78). Since ADR 0104 (Marina 2026-11-03) it also names
 * who ordered (name, phone, email) and lists the lines, so the shop can call the customer from
 * the email. The delivery address stays in the admin. No link that grants anything.
 */
export const newOrderTemplate: EmailTemplate<typeof schema> = {
  id: "order.new",
  version: 4,
  schema,
  render: ({ orderNumber, total, units, areaName, paymentMethod, customer, items }, html) => {
    const payment = PAYMENT_METHOD_LABELS[paymentMethod];
    // Bank transfer and online payment need the team to send details before anything else.
    const todo =
      paymentMethod === "cash_on_delivery"
        ? "A new order is waiting for confirmation."
        : `A new order is waiting for confirmation. The customer chose ${payment.toLowerCase()}: ` +
          `send them the ${paymentMethod === "bank_transfer" ? "bank details" : "payment link"} on WhatsApp.`;
    const count = `${units} ${units === 1 ? "item" : "items"}`;
    const people: Array<readonly [string, string]> = [
      ["Order", orderNumber],
      ["Name", customer.name],
      ["Phone", customer.phone],
      ["Email", customer.email ?? "Not given"],
      ["Area", areaName],
      ["Payment", payment],
    ];
    const lines = items.map((item) => [item.label, item.total] as const);
    const textRows = (rows: ReadonlyArray<readonly [string, string]>) =>
      rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    return {
      subject: `New order ${orderNumber} (${total})`,
      text:
        `${todo}\n\n${textRows(people)}\n\n` +
        `${items.map((item) => `- ${item.label}: ${item.total}`).join("\n")}\n\n` +
        `Total: ${total}\nItems: ${count}\n\n` +
        `Sign in to the admin to see the address and confirm it.\n`,
      html: brandedEmail(html, {
        preheader: `Order ${orderNumber} from ${customer.name}, ${total}, ${count} to ${areaName}.`,
        heading: `New order ${orderNumber}`,
        body:
          html`<p style="margin:0">${todo}</p>` +
          factsTable(html, people) +
          factsTable(html, lines) +
          factsTable(html, [
            ["Total", total],
            ["Items", count],
          ]) +
          html`<p style="margin:0">Sign in to the admin to see the address and confirm it.</p>`,
        footnote: "You receive this because new-order alerts are on in Settings → Notifications.",
      }),
    };
  },
};
