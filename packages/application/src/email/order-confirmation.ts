import { z } from "zod";
import { brandedEmail, factsTable } from "./layout";
import type { EmailTemplate } from "./template";

const money = z.string().min(1).max(40);
const schema = z.strictObject({
  firstName: z.string().min(1).max(100),
  orderNumber: z.string().min(1).max(32),
  /** "TEREA UAE · silver × 2" and its formatted line total. */
  items: z
    .array(z.strictObject({ label: z.string().min(1).max(400), total: money }))
    .min(1)
    .max(100),
  subtotal: money,
  /** Null when there is no discount. */
  discount: money.nullable(),
  delivery: money,
  total: money,
  areaName: z.string().min(1).max(100),
  eta: z.string().min(1).max(500),
  /** A https://wa.me/… link when the store has a WhatsApp number. */
  whatsappUrl: z.url().max(100).nullable(),
});
/**
 * The shopper's order confirmation (ADR 0102), sent to the email given at checkout. It repeats
 * what the confirmation page showed: the order number, the items and the total to pay in cash.
 * It carries no link that grants anything (cross-device order access is out of scope); the only
 * action is the store's WhatsApp, when set.
 */
export const orderConfirmationTemplate: EmailTemplate<typeof schema> = {
  id: "order.confirmation",
  version: 1,
  schema,
  render: (data, html) => {
    const rows: Array<readonly [string, string]> = [
      ["Subtotal", data.subtotal],
      ...(data.discount ? [["Discount", `−${data.discount}`] as const] : []),
      ["Delivery", data.delivery],
      ["Total (cash on delivery)", data.total],
    ];
    const itemsText = data.items.map((item) => `- ${item.label}: ${item.total}`).join("\n");
    const rowsText = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    const contact = data.whatsappUrl
      ? `Questions? Message us on WhatsApp: ${data.whatsappUrl}`
      : "Questions? Reply through the contact details on our website.";
    return {
      subject: `Order ${data.orderNumber} received (${data.total})`,
      text:
        `Hi ${data.firstName},\n\nThank you for your order. We have received it and will call you ` +
        `to confirm it before delivery.\n\nOrder: ${data.orderNumber}\n\n${itemsText}\n\n` +
        `${rowsText}\n\nDelivery to ${data.areaName}: ${data.eta}\n` +
        `Pay in cash when your order arrives.\n\n${contact}\n`,
      html: brandedEmail(html, {
        preheader: `Order ${data.orderNumber}: ${data.total}, cash on delivery to ${data.areaName}.`,
        heading: `Thank you, ${data.firstName}`,
        body:
          html`<p style="margin:0">
            We have received your order <strong>${data.orderNumber}</strong> and will call you to
            confirm it before delivery.
          </p>` +
          factsTable(
            html,
            data.items.map((item) => [item.label, item.total] as const),
          ) +
          factsTable(html, rows) +
          html`<p style="margin:0">
            Delivery to ${data.areaName}: ${data.eta}<br />Pay in cash when your order arrives.
          </p>`,
        ...(data.whatsappUrl
          ? { action: { label: "Message us on WhatsApp", url: data.whatsappUrl } }
          : {}),
        footnote: "You receive this because you placed this order on our website.",
      }),
    };
  },
};
