# 0035 — Checkout input validation: contact, address, area and quantities

- Date: 2026-10-11
- Status: accepted (amends the phone rule of ADR 0034)
- Step(s): 66 (customers: 65; quote: 70–71; order transaction: 75–76)

## Context

Roadmap step 66: shared validators for address, phone, Dubai area and quantity. Done when apartment/villa/office, Makani and notes are bounded and an inactive area is rejected. Architecture §5 asks for configured cart/line quantity caps that reject overflow before calculation; §7 hashes "normalized and merged lines, customer/address" for idempotency, so there must be exactly one normalized form.

Marina decided on 2026-10-11 that orders are taken from UAE mobile numbers only.

## Decision

**One set of rules in `@ih/contracts` (`checkout.ts`)**, used by the storefront form and the API alike. Each schema takes what was typed and returns the normalized value that is stored and hashed, or issues whose path is the field and whose message is the text to show (the prototype's wording, in `CHECKOUT_MESSAGES`). All fields of a form are checked in one pass. Every object is strict: an unknown field, such as a price or a fee, is an error.

| Schema                  | Rules                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkoutContactSchema` | Name 2–100 characters with a letter or digit; phone a UAE mobile in any common spelling, returned as `+9715…`                                                                                                   |
| `checkoutAddressSchema` | Area ID; type apartment, villa or office; building required (150); unit required except for a villa (50); street optional (150); Makani optional, exactly 10 digits after removing spaces; notes optional (500) |
| `orderLinesSchema`      | 1–50 lines; integer quantity 1–10; repeats of a variant are added together and the sum must also be within 10; result sorted by variant ID                                                                      |

**Phone (amends ADR 0034).** `normalizePhone` now accepts only UAE mobiles: `5` and eight more digits after the country code. Landlines, service numbers and numbers of other countries are refused. Any `5x` prefix is accepted on purpose: operators add prefixes, and refusing a real customer is worse than accepting a mistyped number that staff confirmation will catch. The database check stays the general E.164 shape, so widening the rule later needs no migration.

**Nothing is guessed or clamped.** A quantity above the cap, an unknown address type or a missing area is refused, never adjusted. Text is NFC-normalized with whitespace collapsed; control and invisible characters are refused rather than removed. Arabic-Indic and Persian digits are read as digits in the phone and the Makani number.

**Limits.** `ORDER_LIMITS` (50 lines, 10 per item) lives in `@ih/domain`; `mergeOrderLines` applies it. The device cart keeps the same numbers as literals so client code does not bundle the validators, and a test fails if they drift.

**Area.** `readDeliverableArea` (`@ih/db`) answers whether an area exists, is active and is in Dubai; unknown, malformed and inactive are indistinguishable. It takes no lock and is only a pre-check: the quote/order transaction decides again under `lockDeliverySelection`.

**Dependency.** `@ih/contracts` now depends on `@ih/domain` (pure, no Node APIs), so normalization exists once.

## Not built here

- Any route, or the checkout form itself (steps 71 and 77); a store endpoint that lists active areas for the form.
- Real areas, fee or ETA (BI-03): no values are seeded; tests use synthetic areas.
- Per-product quantity limits, or caps configurable by the Owner: the caps are code constants.
- The "I confirm I am 18 or older" checkbox of the prototype checkout: age is the server-side ticket.

## Alternatives considered

- **Restricting to today's known mobile prefixes (50, 52, 54, 55, 56, 58).** Rejected for now: the list changes, and a wrong list turns away real customers. Can be tightened if the client supplies the list.
- **Validators only in the API.** Rejected: the form would need a second copy of every rule and message.
- **Clamping an oversized quantity to the cap.** Rejected: the shopper would be charged for something they did not ask for.

## Consequences

- A tourist with a foreign SIM cannot order; the checkout copy must say a UAE mobile number is needed.
- The API layer must map these issues to the standard error envelope (`fields`) without echoing typed values; the messages themselves contain none.
