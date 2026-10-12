# 0036 — Final prices without a tax calculation, and delivery across the UAE

- Date: 2026-10-12
- Status: accepted (changes launch scope; supersedes the tax parts of ADR 0015/0021 and the Dubai-only rule of the delivery schema)
- Step(s): 39, 44, 51 (changed); 67, 70, 72 (unblocked and simplified)

## Context

On 2026-10-12 Marina answered the open business inputs:

- **BI-02:** tax does not need to be calculated separately. The admin writes the price once.
- **BI-03:** delivery covers the whole UAE.

Until now a product could not be published without an approved VAT/excise treatment reference (database check and readiness rule), which blocked every real publication and the M4 gate; and a delivery area could only be in Dubai (database check, contract literal).

## Decision

**Prices are final.** The price the Owner enters for a product or variant is the amount the customer pays for it. The system does not compute, add, extract or display VAT or excise.

- Publishing no longer requires a tax treatment reference: migration `20261012000100_final_prices` replaces the database check with `products_publishable` (not trashed, price above 0, puff count for a disposable), and `tax_treatment` is removed from the readiness list and the admin copy.
- The `tax_treatment_ref`/`tax_treatment_version` columns and the `taxTreatment` response field stay, always null, so the previous app version keeps working. Removing them is a later contract migration.
- Step 67 becomes integer price arithmetic only: line totals, percentage discount with half-up rounding and its allocation across lines. Order snapshots (step 73) keep unit prices and totals; they carry no tax breakdown.
- Money is still integer fils, never a float, never taken from the client.

**Delivery covers the seven emirates at one flat fee.** Migration `20261012000200_uae_delivery_areas` widens the area check from `dubai` to Abu Dhabi, Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah and Fujairah. An area's emirate is chosen when it is created and, like its code, cannot change. There is still a single fee and ETA text for every area, entered by the Owner; the free-delivery threshold stays off. Areas, fee and ETA are still not seeded.

## Not built here

- Per-emirate or per-area fees and ETAs; delivery outside the UAE.
- A tax line on receipts or reports. If the business must show VAT on invoices or file VAT returns from this system, that is new scope.
- Seeding the areas of each emirate.

## Alternatives considered

- **Keeping the tax reference with a single "inclusive" treatment.** Rejected: it keeps a publish step that has no meaning for the business and one more thing to configure.
- **A free-text emirate.** Rejected: a fixed list keeps reports and the checkout list consistent.

## Consequences

- Whether the entered prices include VAT, and how VAT is reported to the authorities, is handled by the business outside this system. This is a business and accounting decision the software does not check.
- Reports (M10) show sales at entered prices, with no tax columns.
- With one flat fee, a remote area costs the customer the same as a nearby one; the Owner controls coverage only by activating or deactivating areas.
- Project rules change: `CLAUDE.md` no longer says Dubai-only or "accountant-approved allocation", and multi-emirate delivery leaves the out-of-scope list.
