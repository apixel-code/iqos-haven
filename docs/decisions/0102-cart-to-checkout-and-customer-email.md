# 0102 — Straight cart-to-checkout flow and customer order email

- Status: Accepted
- Date: 2026-11-02
- Decided by: Marina (client feedback after launch)

## Context

After launch, Marina reported two problems with the storefront:

1. **Repeated steps.** Adding to cart opened the cart sheet. The header cart opened the same sheet again. Its button led to the cart page, which asked for the delivery area and code. Then the checkout page asked for them again, with the contact and address.
2. **No customer email.** Checkout took only a name and a mobile number. The shop received a new-order email (step 78), but the shopper received nothing.

## Decision

### Cart to checkout

- Adding to cart no longer opens the cart sheet. The header cart count goes up, and a toast says "Added to cart" with a **Checkout** action. The toast does not block the page.
- The header cart (and the bottom-nav cart) opens the cart sheet. The sheet's main button is **Checkout** and goes straight to `/checkout`. That page already holds the delivery area, the code and the accepted server quote (ADR 0041), so the cart page is no longer a required step. `/cart` stays available for editing a larger cart.
- Quick add still opens its own sheet, because a product with options needs a choice. After adding, it closes and shows the same toast.

### Customer email

- Checkout asks for an **email**, which is required on the storefront (`storeContactSchema`). It is stored trimmed and lower-cased in the new nullable `orders.customer_email` column. The migration is expand-only, with a CHECK on the format.
  - Staff-entered orders (`checkoutContactSchema`) may leave it out.
  - Orders placed before this change have none.
- The email is part of the attempt's payload hash only when present. A retry of the same attempt with the email spelled differently is still the same order.
- An order placed from the storefront with an email writes a new event, `order.confirmation_requested` (consumer `email`), in the same transaction as the order, after `order.created`.
- The worker's `customerOrderEmailPlanner` loads the order's own snapshots and sends `orderConfirmationTemplate` to that one address. The email contains:
  - the first name and the order number
  - the items with their totals, plus subtotal, discount, delivery and total (cash on delivery)
  - the delivery area and ETA
  - a WhatsApp button when the store has a number
- The email carries no link that grants access to the order: cross-device order access stays out of scope.
- An order without an email completes the effect with no recipients.
- The admin order detail shows the email under the phone, with the same Customers permission as the phone. It is also a `mailto:` link.
- The privacy page and the order confirmation page say that the confirmation goes to the customer's email.

## Consequences

- Checkout has one more required field. Every order now sends two emails: the shop alert and the shopper's confirmation.
- The email is personal data, kept like the name and phone on the order and never logged.
- On staging the recipient allowlist still holds the shopper's email back.
- Payload hashes of attempts made before this release keep matching, because the field is left out when absent.
- Browser QA scripts follow the new flow (toast → header cart → sheet → Checkout) and fill the email.
