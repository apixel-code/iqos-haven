import { z } from "zod";
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
  version: 1,
  schema,
  render: ({ productName, sku, stock, threshold }, html) => {
    const level = stock === 0 ? "Out of stock" : `${stock} left`;
    return {
      subject: `Low stock: ${productName} (${sku})`,
      text: `A product has reached its low-stock alert level.\n\nProduct: ${productName}\nSKU: ${sku}\nStock: ${level}\nAlert level: ${threshold}\n\nSign in to the admin to update stock.\n`,
      html: html`<p>A product has reached its low-stock alert level.</p>
        <p>
          Product: ${productName}<br />SKU: ${sku}<br />Stock: ${level}<br />Alert level:
          ${threshold}
        </p>
        <p>Sign in to the admin to update stock.</p>`,
    };
  },
};
