import { z } from "zod";
import type { EmailTemplate } from "./template";

/** Amounts arrive already formatted from integer fils, e.g. "AED 1,212.99". */
const money = z.string().min(1).max(40);
const count = z.number().int().min(0);
const schema = z.strictObject({
  /** The Dubai day the figures cover, `YYYY-MM-DD`. */
  day: z.iso.date(),
  booked: z.strictObject({ orders: count, total: money }),
  cancelled: z.strictObject({ orders: count }),
  delivered: z.strictObject({ orders: count, total: money }),
  collected: z.strictObject({ orders: count, amount: money }),
  /** When the figures were computed, Dubai time, e.g. "2026-10-16 09:00". */
  computedAt: z.string().min(1).max(40),
  taxNote: z.string().min(1).max(200),
  topProducts: z
    .array(z.strictObject({ name: z.string().min(1).max(150), units: z.number().int().min(1) }))
    .max(5),
});
/**
 * The day's figures for the Owner and anyone else allowed to see revenue (step 107, ADR 0073).
 * Totals and product names only: no order numbers, customers or links. Each basis keeps its own
 * date meaning (ADR 0071). Neutral wording until the client approves copy (BI-01).
 */
export const dailySummaryTemplate: EmailTemplate<typeof schema> = {
  id: "report.daily_summary",
  version: 1,
  schema,
  render: (data, html) => {
    const lines = [
      `Placed: ${data.booked.orders} active orders, ${data.booked.total} (by order date)`,
      `Cancelled: ${data.cancelled.orders} of the orders placed that day`,
      `Delivered: ${data.delivered.orders} orders, ${data.delivered.total} (by delivery date)`,
      `Cash collected: ${data.collected.orders} orders, ${data.collected.amount} (by collection date)`,
    ];
    const products = data.topProducts.map((product) => `${product.name}: ${product.units}`);
    const footer = `All days are Asia/Dubai. Figures computed ${data.computedAt} (Dubai time). ${data.taxNote}`;
    return {
      subject: `Daily summary for ${data.day}`,
      text:
        `Daily summary for ${data.day}\n\n${lines.join("\n")}\n\n` +
        (products.length ? `Most ordered (units):\n${products.join("\n")}\n\n` : "") +
        `${footer}\n`,
      html:
        html`<p>Daily summary for ${data.day}</p>
          <p>${lines[0]}<br />${lines[1]}<br />${lines[2]}<br />${lines[3]}</p>` +
        (products.length
          ? html`<p>Most ordered (units):</p>` +
            "<ul>" +
            products.map((line) => html`<li>${line}</li>`).join("") +
            "</ul>"
          : "") +
        html`<p>${footer}</p>`,
    };
  },
};
