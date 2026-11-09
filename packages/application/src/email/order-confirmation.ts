import { z } from "zod";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_NEXT_STEP, PAYMENT_METHODS } from "@ih/domain";
import { brandedEmail, factsTable } from "./layout";
import type { EmailTemplate } from "./template";

const money = z.string().min(1).max(40);
const schema = z.strictObject({
  firstName: z.string().min(1).max(100),
  orderNumber: z.string().min(1).max(32),
  /** What the shopper gave at checkout, repeated so they can check it (ADR 0104). */
  customer: z.strictObject({
    name: z.string().min(1).max(100),
    phone: z.string().min(1).max(20),
    email: z.string().min(1).max(254),
  }),
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
  /** How the shopper chose to pay (ADR 0111). */
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** A https://wa.me/… link when the store has a WhatsApp number. */
  whatsappUrl: z.url().max(100).nullable(),
  /** The store's order tracking page (ADR 0104) when the store has a domain; carries no number. */
  trackUrl: z.url().max(300).nullable(),
});
/**
 * The shopper's order confirmation (ADR 0102), sent to the email given at checkout. It repeats
 * what the confirmation page showed: the order number, the items, the total and, since ADR 0111,
 * how the shopper chose to pay and what happens next.
 * Since ADR 0104 it also repeats the name, phone and email given, and points to the tracking
 * page, where the order number alone shows the order's status. No link carries the number.
 */
export const orderConfirmationTemplate: EmailTemplate<typeof schema> = {
  id: "order.confirmation",
  version: 3,
  schema,
  render: (data, html) => {
    const rows: Array<readonly [string, string]> = [
      ["Subtotal", data.subtotal],
      ...(data.discount ? [["Discount", `−${data.discount}`] as const] : []),
      ["Delivery", data.delivery],
      ["Total", data.total],
      ["Payment", PAYMENT_METHOD_LABELS[data.paymentMethod]],
    ];
    const nextStep = PAYMENT_METHOD_NEXT_STEP[data.paymentMethod];
    const itemsText = data.items.map((item) => `- ${item.label}: ${item.total}`).join("\n");
    const rowsText = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    const details: Array<readonly [string, string]> = [
      ["Order number", data.orderNumber],
      ["Name", data.customer.name],
      ["Phone", data.customer.phone],
      ["Email", data.customer.email],
    ];
    const detailsText = details.map(([label, value]) => `${label}: ${value}`).join("\n");
    const track = data.trackUrl ? `Track your order with its number at ${data.trackUrl}\n\n` : "";
    const contact = data.whatsappUrl
      ? `Questions? Message us on WhatsApp: ${data.whatsappUrl}`
      : "Questions? Reply through the contact details on our website.";
    return {
      subject: `Order ${data.orderNumber} received (${data.total})`,
      text:
        `Hi ${data.firstName},\n\nThank you for your order. We have received it and will call you ` +
        `to confirm it before delivery.\n\n${detailsText}\n\n${itemsText}\n\n` +
        `${rowsText}\n\nDelivery to ${data.areaName}: ${data.eta}\n` +
        `${nextStep}\n\n${track}${contact}\n`,
      html: brandedEmail(html, {
        preheader: `Order ${data.orderNumber}: ${data.total}, ${PAYMENT_METHOD_LABELS[data.paymentMethod].toLowerCase()}, delivery to ${data.areaName}.`,
        heading: `Thank you, ${data.firstName}`,
        body:
          html`<p style="margin:0">
            We have received your order <strong>${data.orderNumber}</strong> and will call you to
            confirm it before delivery.
          </p>` +
          factsTable(html, details) +
          factsTable(
            html,
            data.items.map((item) => [item.label, item.total] as const),
          ) +
          factsTable(html, rows) +
          html`<p style="margin:0">Delivery to ${data.areaName}: ${data.eta}<br />${nextStep}</p>` +
          (data.trackUrl
            ? html`<p style="margin:0">
                Track your order any time: enter <strong>${data.orderNumber}</strong> at
                <a href="${data.trackUrl}">${data.trackUrl}</a>
              </p>`
            : ""),
        ...(data.whatsappUrl
          ? { action: { label: "Message us on WhatsApp", url: data.whatsappUrl } }
          : {}),
        footnote: "You receive this because you placed this order on our website.",
      }),
    };
  },
};
