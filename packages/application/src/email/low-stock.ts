import { z } from "zod";
import { brandedEmail, factsTable } from "./layout";
import type { EmailTemplate } from "./template";

const schema = z.strictObject({
  productName: z.string().min(1).max(150),
  sku: z.string().min(1).max(64),
  stock: z.number().int().min(0),
  threshold: z.number().int().min(0),
});
/**
 * Tells the shop a product variant reached its alert level (step 92). Catalogue facts only, and
 * no link: the message goes to a mailbox outside the system. Neutral wording until the client
 * approves copy (BI-01).
 */
export const lowStockTemplate: EmailTemplate<typeof schema> = {
  id: "inventory.low",
  version: 2,
  schema,
  render: ({ productName, sku, stock, threshold }, html) => {
    const level = stock === 0 ? "Out of stock" : `${stock} left`;
    return {
      subject: `Low stock: ${productName} (${sku})`,
      text: `A product has reached its low-stock alert level.\n\nProduct: ${productName}\nSKU: ${sku}\nStock: ${level}\nAlert level: ${threshold}\n\nSign in to the admin to update stock.\n`,
      html: brandedEmail(html, {
        preheader: `${productName} (${sku}): ${level}.`,
        heading: stock === 0 ? "A product is out of stock" : "A product is running low",
        body:
          html`<p style="margin:0">A product has reached its low-stock alert level.</p>` +
          factsTable(html, [
            ["Product", productName],
            ["SKU", sku],
            ["Stock", level],
            ["Alert level", String(threshold)],
          ]) +
          html`<p style="margin:0">Sign in to the admin to update stock.</p>`,
        footnote: "You receive this because low-stock alerts are on in Settings → Notifications.",
      }),
    };
  },
};
