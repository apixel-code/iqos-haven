# 0037 — Integer pricing, one discount per order and its allocation

- Date: 2026-10-12
- Status: accepted
- Step(s): 67 (coupons: 68; delivery fee and quote: 70–71; order transaction: 75–76)

## Context

Roadmap step 67: integer pricing and rounding allocation, with no floats and no client prices. Its tax part is gone: prices are final as entered (ADR 0036). Architecture §6: apply the active variant's price override or the product price, ignore client price fields; calculate the order discount with integer arithmetic and half-up rounding once per order; allocate it across lines with the largest-remainder method.

## Decision

**Arithmetic (`@ih/domain`, `priceOrder`).**

1. Line subtotal = unit price × quantity.
2. Merchandise subtotal = sum of line subtotals.
3. Discount = subtotal × basis points ÷ 10,000, rounded half-up, once for the whole order. Merchandise only.
4. Total = subtotal − discount + delivery fee. Delivery is never discounted.

Everything is an integer number of fils; products that could exceed 2^53 are computed with BigInt. Inputs are bounded (unit price 1 to 1,000,000,000 fils, quantity 1–10, 1–50 merged lines, 0–10,000 basis points, fee 0 to 1,000,000,000), so the largest total is far inside the safe integer range. Anything outside the bounds, any float and any repeated variant throws: the function never clamps.

**Allocation (`allocateLargestRemainder`).** Each line's share of the discount is its proportional part rounded down; the fils left over go, one each, to the lines that lost the largest fraction, and equal fractions are settled by line position. Lines are always in variant-ID order, so the same cart always gets the same shares. The shares add up to the discount exactly and no share exceeds its line.

Worked example: lines of AED 90.00 and AED 129.99, 15 % off. Subtotal 219.99; discount 32.9985 → AED 33.00; shares 13.50 and 19.50; with AED 15.00 delivery the total is AED 201.99.

**Prices come from the database (`@ih/db`).**

- `readOrderPrices` returns, for merged lines, the current unit price (variant override, else product price) with the product and variant versions, for variants a shopper may see (the store visibility rule). A line that cannot be bought makes the whole read fail with `VariantUnavailableError` naming the variant IDs; unknown and hidden are indistinguishable. No lock: quote preview only.
- `lockOrderPrices` is the catalogue group of the resource order. It holds the brands, then categories, then products of the lines FOR SHARE, each in ID order, and reads the same data. Every admin path that changes a price, a variant's active flag, publication, trash or a parent's visibility first takes one of those rows FOR UPDATE, so nothing read here can change before the order commits. Variant rows are not share-locked: stock takes them FOR UPDATE later, and two orders upgrading a shared lock on the same variant would deadlock.
- If a product changed brand or category between the parent locks and its own lock, `TransactionRestartError` makes `withTransaction` start the transaction again (it is retried like a deadlock, at most three attempts).

## Not built here

- Coupon eligibility, minimum spend and usage (step 68); the delivery fee source and quote assembly (step 70); the signed quote and its fingerprint (step 71).
- Stock sufficiency: stock is checked and consumed in the order transaction, not here.
- Any route.

## Alternatives considered

- **Rounding the discount per line and summing.** Rejected: the order discount would drift from the advertised percentage by up to one fil per line.
- **Giving all leftover fils to the largest line.** Rejected: largest-remainder is the method the architecture names and keeps every share within one fil of its exact value.
- **Share-locking variants at the price stage.** Rejected: deadlock between two orders of one variant.

## Consequences

- A cart with one unavailable line cannot be priced at all; the caller shows which lines to remove.
- Line shares exist for reports only; the customer is charged the order total.
