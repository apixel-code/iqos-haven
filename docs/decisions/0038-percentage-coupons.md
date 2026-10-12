# 0038 — Percentage coupons: eligibility, locked use count and release

- Date: 2026-10-12
- Status: accepted
- Step(s): 68 (Owner coupon screen: 69; quote: 70–71; order tables and the `order_id` foreign key: 73; order transaction: 75–76; cancellation: 86)

## Context

Roadmap step 68: `coupons`, `coupon_redemptions` and a promotion service; one code and no stacking; expiry and minimum; a locked usage counter and release rules. Architecture §6: one percentage code per order, merchandise only, minimum spend tested on the pre-discount merchandise subtotal, expiry tested against server time, percentage in basis points; the limit is checked and incremented while the coupon row is locked, in the order transaction; a pre-delivery cancellation releases the redemption once.

## Decision

**One kind of coupon.** A code, a percentage (1–10,000 basis points), an optional minimum merchandise subtotal, optional start and expiry, an active flag and an optional usage limit. There is no fixed-value, brand-scoped or stacking mechanism, and nothing is seeded.

**Code.** Stored in upper case, 3–32 characters of `A–Z`, `0–9`, `_` and `-`, unique, and fixed once created. What a shopper types is trimmed and upper-cased, nothing more. The input is a single string, so there is no way to send two codes.

**Eligibility (`couponRejection`, `@ih/domain`)** gives one reason in a fixed order: unknown, inactive, not started, expired, minimum not met, limit reached. Expiry is exclusive. "Now" is the database clock, read in the same statement as the coupon row. The subtotal is the server-computed merchandise subtotal before the discount.

**What the shopper is told.** `CouponRejectedError.code` is `COUPON_LIMIT_REACHED` for a full coupon and `COUPON_INVALID` for everything else. The detailed reason stays on the server and is not in any contract, because it would tell a guesser which codes exist. A store route must answer with the code only and be rate limited.

**The use count cannot drift or exceed the limit.**

- `coupons.active_redemptions` is changed only by a trigger on `coupon_redemptions`: an insert adds one, a release subtracts one. A direct write is refused (trigger-depth guard), and the runtime role has no UPDATE right on that column at all; the trigger function is SECURITY DEFINER with a pinned search path.
- A table check (`active_redemptions <= usage_limit`) is the last line of defence: even a caller that skips every application check cannot exceed the limit.
- `couponCountMismatches` lists coupons whose count disagrees with their rows; it must always be empty.

**In an order (`@ih/db`).**

1. `lockCouponForOrder(tx, code, subtotal)` locks the coupon row FOR UPDATE (the coupon group of the resource order, after catalogue prices and before variants) and decides eligibility under that lock. Two orders racing for the last use are serialized: the second sees the first one's count.
2. `redeemCoupon(tx, orderId, applied)` records the use with a snapshot (code, percentage, subtotal, discount). It accepts only the object returned by `lockCouponForOrder` in the same transaction, so what is recorded is what was decided under the lock.
3. A failed order rolls back the use with everything else.

`previewCoupon` runs the same decision without a lock and records nothing, for quotes.

**No stacking, ever.** `coupon_redemptions.order_id` is unique: an order has at most one redemption for its whole life, including after a release.

**Release.** `releaseCouponRedemption(tx, orderId)` sets `released_at` once, under the coupon lock, and returns whether it did. A redemption row can change in no other way (trigger, and the runtime role may update only `released_at`); it is never deleted, so the history stays. The freed use is available to the next order.

**Later edits do not rewrite history.** The redemption keeps its own percentage and amounts.

## Not built here

- Creating and editing coupons: Owner API and screen (step 69), including audit entries and events for those edits.
- The foreign key from `coupon_redemptions.order_id` to `orders`: added with the orders migration (step 73).
- Any store route, the quote (steps 70–71) and the caller of release (cancellation, step 86).
- Per-customer limits ("once per phone").

## Alternatives considered

- **Counting redemption rows instead of keeping a counter.** Rejected: the architecture names a locked counter, and a check constraint on a counter is a guarantee the database enforces by itself.
- **Maintaining the counter in application code.** Rejected: any future writer could forget; the trigger cannot.
- **Returning the precise reason to the shopper.** Rejected for unknown/inactive/expired (code probing). The minimum-spend case could get its own message later without revealing more than the shopper already holds.

## Consequences

- A coupon that gives a discount of 0 fils on a tiny order still counts as a use.
- An Owner cannot lower a usage limit below the number of active uses: the database refuses, and step 69 must show that as a clear message.
- Step 69's edit command must compare and bump `version` itself; the database only refuses a decrease.
- No trigger other than `coupon_redemption_apply` may write `coupons`.
