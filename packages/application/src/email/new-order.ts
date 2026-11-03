import { z } from "zod";
import { brandedEmail, factsTable } from "./layout";
import type { EmailTemplate } from "./template";

const money = z.string().min(1).max(40);
const schema = z.strictObject({
  orderNumber: z.string().min(1).max(32),
  /** Already formatted from integer fils, e.g. "AED 212.99". */
  total: money,
  units: z.number().int().min(1),
  areaName: z.string().min(1).max(100),
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
  version: 3,
  schema,
  render: ({ orderNumber, total, units, areaName, customer, items }, html) => {
    const count = `${units} ${units === 1 ? "item" : "items"}`;
    const people: Array<readonly [string, string]> = [
      ["Order", orderNumber],
      ["Name", customer.name],
      ["Phone", customer.phone],
      ["Email", customer.email ?? "Not given"],
      ["Area", areaName],
    ];
    const lines = items.map((item) => [item.label, item.total] as const);
    const textRows = (rows: ReadonlyArray<readonly [string, string]>) =>
      rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    return {
      subject: `New order ${orderNumber} (${total})`,
      text:
        `A new cash-on-delivery order is waiting for confirmation.\n\n${textRows(people)}\n\n` +
        `${items.map((item) => `- ${item.label}: ${item.total}`).join("\n")}\n\n` +
        `Total (cash on delivery): ${total}\nItems: ${count}\n\n` +
        `Sign in to the admin to see the address and confirm it.\n`,
      html: brandedEmail(html, {
        preheader: `Order ${orderNumber} from ${customer.name}, ${total}, ${count} to ${areaName}.`,
        heading: `New order ${orderNumber}`,
        body:
          html`<p style="margin:0">A new cash-on-delivery order is waiting for confirmation.</p>` +
          factsTable(html, people) +
          factsTable(html, lines) +
          factsTable(html, [
            ["Total (cash on delivery)", total],
            ["Items", count],
          ]) +
          html`<p style="margin:0">Sign in to the admin to see the address and confirm it.</p>`,
        footnote: "You receive this because new-order alerts are on in Settings → Notifications.",
      }),
    };
  },
};
