# 0056 — Manual orders entered by staff

- Date: 2026-10-14
- Status: accepted
- Step(s): 88

## Context

Roadmap step 88: a manual order wizard. Done condition: the same quote, inventory and idempotency services as the storefront; a Confirmed start requires recorded evidence. Architecture §6: "A manual order may create Confirmed only through a permissioned command that records the operator and confirmation evidence"; §7: manual order keys are scoped to the endpoint and the authenticated principal. The order schema (ADR 0042) already allows `source = 'manual'` with `created_by`, and a first history row of Confirmed for manual orders only.

## Decision

**One order transaction.** `createStoreOrder` (ADR 0045) takes an optional `manual` part (`actorId`, `start`, `evidence`) instead of a separate copy. A manual order:

- claims its attempt key in the scope `admin.order.create:<staff id>`, so keys of different staff never meet and a cleaned-up key still never orders twice;
- checks under the claim, with the staff row share-locked, that the staff member holds `orders.create`, and also `orders.transition` to start Confirmed;
- then follows the storefront path unchanged: the same lock order, server quote check, stock through `SALE`, coupon use, customer and address, order snapshots, audit and `order.created` (so the inbox and email consumers see it);
- writes `source = 'manual'`, `created_by`, status Pending or Confirmed, and a first history row by that staff member whose reason is the evidence ("Confirmed by phone call: …");
- gets no confirmation cookie; its stored answer adds the order ID and status, which only that staff member's key can replay.

**Routes** (`orders.create`, admin Origin, a fail-closed per-address and per-actor limit):

- `GET /v1/admin/orders/delivery-areas`: active areas, fee and ETA (the storefront's delivery read; the admin delivery screen needs `delivery.manage`, which Staff lacks).
- `POST /v1/admin/orders/quote`: the storefront's quote service; returns the total and its signed token.
- `POST /v1/admin/orders` with `Idempotency-Key`: `manualOrderRequestSchema` — contact, address, lines, coupon, the quote token, `ageConfirmed: true` (the staff member attests the customer said they are 18 or older), `start`, and `evidence` (`channel`: phone, WhatsApp or in person; `note`) exactly when `start` is Confirmed. The same refusal codes as the storefront route; 403 without the rights.

**Admin.** "New order" on the orders screen: customer, address, items by variant ID with quantities, an optional code, "Get total" (any change clears it), the start (Confirmed only for staff who may confirm, with how it was confirmed), the 18+ attestation and "Create order · total". The attempt key is kept in memory until the order is acknowledged, then the new order opens.

**Database rule.** A first history row that starts an order Confirmed must carry a reason (migration `20261014000300_manual_order_evidence`), so no code path can create a Confirmed order without recorded evidence.

**Quote route limits.** The admin quote route uses the per-address and per-actor staff limit, not the storefront's wrong-coupon budget: staff are authenticated and audited, and a guessing staff account is a different problem (deactivation).

## Consequences

- A manual order behaves like any other afterwards: transitions, edits, cancellation and collection apply.
- The age policy version recorded is the API's current one, as for the storefront; for a manual order it means the staff member's attestation, which the audit entry attributes to that staff member ("manual order").
- The admin form renews its attempt key after a definite refusal (nothing was placed) and keeps it after an unclear answer or when the key already made an order.
- Items are chosen by variant ID, as in order edits; a searchable picker can replace that input later without changing the command.
- The evidence is free text visible in the order history; staff should not put more personal data in it than needed.
