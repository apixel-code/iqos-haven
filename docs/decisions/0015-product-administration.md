# 0015 — Product administration: draft-first editor, typed specs, read-only tax reference

- Date: 2026-10-10
- Status: accepted; the tax-treatment publish requirement is superseded by ADR 0036 (prices are final, no tax reference)
- Step(s): 44 (extended by 45–51, 67)

## Context

Roadmap step 44 asks for product create, edit, detail and list, with typed specs, draft/published status, brand/category/type/puffs, price and tax-treatment references, and conflicts on stale edits.

The prototype differs from this in four ways, and none of them is a requirement:

- Its specs are free-form label/value rows, with type-specific seed data.
- It uses whole-AED prices.
- It has no compare-at price and no "new" flag.
- It publishes from the editor.

Architecture §5 lists compare-at price, an approved VAT/excise-treatment reference/version and `is_new`. BI-02 (VAT/excise treatment) is OPEN.

## Decision

**API.** `GET/POST /v1/admin/products` and `GET/PATCH /v1/admin/products/:id`.

- `catalog.read` covers list and detail; `catalog.write` covers create and edit.
- SEO is Owner-only: removed by the field policy, and writing it needs `seo.write`.
- Bodies are a strict union discriminated on `type`:
  - `disposable`: `puffCount` may be null while the product is a draft. Specs: `liquidMl`, `batteryMah`, `rechargeable`, `charging`.
  - `kit`: `puffCount` must be null. Specs: `batteryMah`, `maxOutputW`, `podCapacityMl`, `coilOhm`, `charging`, `display`, `inTheBox`.
  - Both types also accept up to 12 free-form `extra` rows.
  - Decimal spec values are pattern-checked strings, never floats.
- Money is integer fils, 0 to 1,000,000,000. A compare-at price must be above the base price, and this is checked in both the contract and the DB.
- The list is keyset-paged over `id` descending (UUIDv7, newest first). It filters by status, brand and category, and searches names with a literal (escaped) ILIKE, at most 100 per page. List rows are summaries.

**Status.** New products are always drafts. The editor never changes `status`; publication and trash belong to step 51.

**Tax treatment.** The `taxTreatment` reference is read-only and starts as null. It becomes writable once approved treatments exist (BI-02, step 67). The step-41 CHECK requires the reference for publishing, so no product can be published before BI-02 is answered. This is intended.

**Transactions.** Each write runs in one Read Committed transaction:

1. The actor row is locked `FOR SHARE` and permissions are rechecked.
2. The target brand, then category, are locked `FOR SHARE` and must exist and be live; otherwise the response is 409 `PARENT_UNAVAILABLE`.
3. The product is locked `FOR UPDATE` and the expected version checked.
4. The write happens. A slug rename stores a direct redirect.
5. Audit records names, prices, flags, and `specsChanged`/`descriptionChanged`/`seoChanged`; it never stores description or SEO text. The `catalog.changed` event (`entityType: "product"`) carries IDs only.

Checks run in this order: not found (404), stale version, trashed. After that, `PARENT_UNAVAILABLE` applies only when the edit moves the product to another parent, or when the product is published. A draft may keep a parent that was trashed later. For a published product, the published-state rules (positive price; puffs for disposables) are checked up front and refused with 409 `PUBLISH_REQUIREMENTS`. Other CHECK failures stay loud server errors; they are not mapped to a business conflict. Text fields reject NUL characters (400). A caller without `seo.write` who sends `seo` gets 403, even if the value is unchanged.

**Admin UI.** A Products workspace provides:

- A list with All/Published/Drafts tabs, brand and category filters, and name search.
- A draft-first editor that changes its spec fields by type, converts AED text to fils without floats, keeps the slug suggested from the name until edited, has a "New" badge toggle, and shows SEO only to holders of `seo.write`.

## Alternatives considered

- Free-form specs only, as in the prototype: units and types would be unenforced, and the roadmap asks for typed specs. The `extra` rows keep its flexibility.
- Nicotine and flavour in specs: these are variant options with their own stock and SKU (step 45).
- Writable tax reference now: a free-text reference would let anyone "approve" a treatment, which is the accountant's decision (BI-02).
- Publish from the editor: publication has its own rules (images, variants, tax) and is step 51.

## Consequences

- SKU search and stock columns arrive with variants and stock (45–47).
- Images arrive in 48–50. The editor shows no image controls yet.
- Steps 45 and 51 must lock the product parents before the product, as here.
- Products cannot be published until BI-02 is answered.
