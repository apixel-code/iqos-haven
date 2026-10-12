# 0039 — Owner coupon administration and Trash

- Date: 2026-10-12
- Status: accepted
- Step(s): 69 (coupon model and order use: 68, ADR 0038)

## Context

Roadmap step 69: Owner coupon CRUD and the discount admin screen; percentage only, versions and audit, active/expiry/limit checks. `apps/admin/CLAUDE.md`: coupons are percentage only, soft-deleted (trash/restore), never hard-deleted. Architecture §2: promotions are Owner only.

## Decision

**Routes** (`AdminCouponsController`, all need `coupons.manage`, which only the Owner role holds; the repository checks it again under the actor lock):

| Route                                | Does                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| `GET /v1/admin/coupons`              | Newest first, keyset cursor, `trashed=true` for the Trash list |
| `POST /v1/admin/coupons`             | Create                                                         |
| `PATCH /v1/admin/coupons/:id`        | Replace every editable term, naming the version seen           |
| `POST /v1/admin/coupons/:id/trash`   | Move to Trash                                                  |
| `POST /v1/admin/coupons/:id/restore` | Bring back, inactive                                           |

There is no delete route. Responses are `no-store`; mutations are rate limited per address and actor.

**What can be set.** Code (on create only), percentage in basis points, minimum merchandise subtotal in fils, start, end, active, usage limit. The request objects are strict: a fixed amount, a brand or product scope, a type or a use count is a 400. The use count and the code can never be edited (ADR 0038 removes even the database right).

**Every change is one transaction:** owner-role lock, actor share lock and permission, the coupon row FOR UPDATE, the version comparison, the write with `version + 1`, one audit entry (the terms before and after, no customer data) and one `coupon.updated` event. Saving unchanged values writes nothing.

**Checks, answered as 409 with a stable code:**

| Code                      | When                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `VERSION_CONFLICT`        | The coupon changed since it was loaded                                                                    |
| `DUPLICATE`               | The code exists, in any letter case, including in Trash                                                   |
| `LIMIT_BELOW_USES`        | The new usage limit is below the uses orders currently hold                                               |
| `ALREADY_EXPIRED`         | Activating a coupon whose end has passed, or moving an active coupon's end into the past (database clock) |
| `TRASHED` / `NOT_TRASHED` | Editing or trashing a trashed coupon; restoring one that is not trashed                                   |

A coupon that simply ran out stays editable. The end must be after the start (400).

**Trash.** Migration `20261012000400_coupon_trash` adds `deleted_at` with a check that a trashed coupon is inactive, so no order can use it. Trash deactivates; restore returns the coupon inactive, so nothing goes live by accident. The code stays reserved. Orders that used the coupon keep their redemption rows.

**Status** shown to the Owner (`couponStatus`, database clock): In Trash, Inactive, Scheduled, Ended, Used up, Live.

**Screen.** "Discounts" in the Management group, visible with `coupons.manage`: a Codes tab and a Trash tab, an "Add code" form, one card per code with a plain sentence of what it does ("12.5% off products on orders of AED 100.00 or more of products. Delivery is not discounted. 3 of 50 used."), edit form, Move to Trash, Restore as inactive. Percentages and amounts are parsed from text into integers; dates are entered in the device's local time and sent as instants.

## Not built here

- A usage history list per coupon, and totals of discount given (reports, M10).
- Purging a coupon; bulk actions; search.
- Applying a coupon in the store (steps 70–71).

## Alternatives considered

- **Deactivate only, no Trash.** Rejected: the admin rules ask for trash/restore, and a long list of dead codes is noise.
- **PATCH of single fields.** Rejected: replacing all terms against one version keeps the "what did the Owner see" question simple.

## Consequences

- A code can never be reused, even after its coupon is trashed.
- Times are shown and entered in the device's time zone; an Owner outside the UAE sees their own local time.
