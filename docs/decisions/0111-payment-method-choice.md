# 0111 — The shopper chooses a payment method, with no payment gateway

- Status: Accepted
- Date: 2026-11-09
- Decided by: Marina (client request)

## Context

Until now the store took cash on delivery only. The terms said "We do not take card or online payments." The client also takes bank transfers and online payments (a payment link the team sends). The client does not want a payment gateway: the site must not take card details or confirm payments by itself.

The client asked for two things:

- customers should know that every payment method is accepted;
- customers should choose at checkout how they will pay, so the team knows what to send them.

We looked at Stripe Link (link.com) first and set it aside: Stripe's published rules exclude tobacco and e-cigarette sales.

## Decision

- **Order field:** a new `orders.payment_method` column holds `cash_on_delivery`, `bank_transfer` or `online_payment`.
  - It is enforced by a CHECK constraint. Migration `20261109000100_payment_method` is expand-only: `NOT NULL DEFAULT 'cash_on_delivery'`.
  - The previous release never names the column, and every earlier order reads as cash on delivery, which it was.
  - The names, labels and the shopper's next step live in `@ih/domain` (`PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS`, `PAYMENT_METHOD_NEXT_STEP`) and are re-exported by `@ih/contracts`.
- **Requests:**
  - The store order and the manual order requests take `paymentMethod`. Left out, it means cash on delivery, so a checkout page loaded before this release still works.
  - The method is part of the idempotency payload only when it is not cash. Attempts hashed before this change still replay. The same key with a different method is a conflict.
- **Edits:** staff can change the method in an order edit while the order is Pending or Confirmed. The edit is recorded in the edit diff (`paymentMethod.before/after`). The existing `orders_guard` trigger already fixes all order contents once processing starts, so this column needs no trigger change.
- **No new payment state:** the existing record of money received (`cod_status` and collection records, ADR 0055) is reused for every method. It is still recorded after delivery. The admin words it as "Record payment received" and "Awaiting payment" when the method is not cash. Nothing marks an order paid by itself.
- **Where the method shows:**
  - **Storefront:** the checkout payment step has three choices, cash preselected. For bank transfer and online payment the team sends the details on WhatsApp, and the bank details are never shown on the site. The confirmation page also shows the method and the next step.
  - **Emails:** the shopper's confirmation (template v3) and the shop's new-order email (v4). The new-order email tells the team what to send.
  - **Admin:** the orders table, order detail, customer history, manual order wizard and order edit.
  - **Packing slip:** "Do not collect cash" when the customer pays by bank transfer or online.
  - **Report CSV:** the Payment and Payment status columns.
  - **WhatsApp templates:** a new `{{payment}}` placeholder. The default confirmation text uses it.
- **Copy:** every "Cash on delivery" mention also says "All payment methods accepted": hero, product page, cart, cart sheet, footer and the link preview image. The Help FAQ, terms §4 and the privacy policy describe the three methods. They also state that card details are never asked for on the site.

## Consequences

- Staff must send bank details or a payment link on WhatsApp for those orders. They must check the money arrived before dispatch, because the site cannot know.
- An Owner-saved WhatsApp confirmation template that says "cash on delivery" keeps saying so. The Owner should add `{{payment}}` in Settings → WhatsApp.
- Taking card payments on the site later would need a gateway that accepts heated tobacco, and a new ADR.
