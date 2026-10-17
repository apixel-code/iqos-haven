import { z } from "zod";
import type { EmailTemplate } from "./template";

const schema = z.strictObject({
  orderNumber: z.string().min(1).max(32),
  /** Already formatted from integer fils, e.g. "AED 212.99". */
  total: z.string().min(1).max(40),
  units: z.number().int().min(1),
  areaName: z.string().min(1).max(100),
});
/**
 * Tells the shop a new order arrived (step 78). It goes to a mailbox outside the system, so it
 * says only what is needed to go and look: no customer name, phone or address, and no link
 * that grants anything. Neutral wording until the client approves copy (BI-01).
 */
export const newOrderTemplate: EmailTemplate<typeof schema> = {
  id: "order.new",
  version: 1,
  schema,
  render: ({ orderNumber, total, units, areaName }, html) => {
    const items = `${units} ${units === 1 ? "item" : "items"}`;
    return {
      subject: `New order ${orderNumber} (${total})`,
      text: `A new cash-on-delivery order is waiting for confirmation.\n\nOrder: ${orderNumber}\nTotal: ${total}\nItems: ${items}\nArea: ${areaName}\n\nSign in to the admin to see the details and confirm it.\n`,
      html: html`<p>A new cash-on-delivery order is waiting for confirmation.</p>
        <p>
          Order: ${orderNumber}<br />Total: ${total}<br />Items: ${items}<br />Area: ${areaName}
        </p>
        <p>Sign in to the admin to see the details and confirm it.</p>`,
    };
  },
};
