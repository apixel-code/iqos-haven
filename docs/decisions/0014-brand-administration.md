# 0014 — Brand administration: versioned CRUD, reference-aware trash, Owner-only SEO

- Date: 2026-10-10
- Status: accepted
- Step(s): 42 (pattern reused by 43–44, 51, 101)

## Context

REQ-03 and architecture §5/§11 ask for several things:

- Brand lists, editors, ordering, an active toggle and trash/restore.
- Staff may create, edit, publish and trash catalogue entries.
- SEO fields are Owner-only.
- A parent still needed by published products must not be deleted.

The prototype lets you trash a brand with linked products and hard-delete it. Both are prototype demo logic, not requirements.

## Decision

**API.** `GET/POST /v1/admin/brands`, `GET/PATCH /v1/admin/brands/:id`, and `POST /v1/admin/brands/:id/trash|restore`.

- Permissions:
  - `catalog.read` for list and detail.
  - `catalog.write` for create and edit.
  - `catalog.trash` for trash and restore.
  - `seo.write` in addition to send `seo`.
- `seo` is removed from responses for callers without `seo.write` (field policy). If the field is omitted on update, it stays unchanged.
- Contracts are strict and bounded.
- The list uses a keyset over `(sortOrder, id)`, with a maximum of 100 per page and separate `live`/`trashed` views.
- Mutations are no-store and use a fail-closed `catalog_manage` limit: 300 per actor and 600 per IP per hour.

**Transactions.** Each mutation runs in one Read Committed transaction:

1. The actor row is locked `FOR SHARE` and permissions are rechecked. This serializes with deactivation and role changes without taking the global Owner-role lock.
2. The brand is locked `FOR UPDATE` and the expected version is checked (otherwise 409).
3. The write happens, `version` increments and `updated_at` is set from the DB clock.
4. An audit entry (names and flags only, plus `seoChanged`, never SEO text) and an IDs-only `catalog.changed` outbox event (`entityType: "brand"`) are written.

A genuine no-op is not versioned.

**Trash and restore.**

- Trash is soft (`deleted_at`) and is refused with 409 while live published products use the brand.
- Trashed brands are read-only until restored.
- Products are never modified.
- A `products` trigger enforces the other side in the database: any insert or update of a published product locks its brand and category `FOR SHARE` and refuses a trashed parent. Trash locks the brand `FOR UPDATE` before counting, so trash and publish serialize and the later one sees the earlier.
- 409 bodies carry a stable reason from an allowlist: `VERSION_CONFLICT`, `DUPLICATE`, `TRASHED` or `IN_USE`. The admin UI shows a specific message for each.
- A caller without `seo.write` who sends `seo` gets 403, even when the value is unchanged. The UI never sends it for such callers.
- Permanent purge stays in step 51 (Owner-only, reference-checked).

**Slugs and names.**

- A slug rename inserts a direct `slug_redirects` alias from the old slug.
- Reclaiming a previous slug first deletes that brand's own alias in the same transaction.
- Names are unique case-insensitively, including trashed rows (migration `20261010000500_catalogue_parents`).

**Admin UI.**

- A "Brands" workspace with "Brands | Trash" tabs, a create form with the slug suggested from the name, and per-brand edit cards.
- "Show in store" toggle, display order, and trash/restore buttons with confirmation.
- Controls follow server grants, and SEO fields appear only with `seo.write`.
- Logos wait for the media pipeline (48–50).

## Alternatives considered

- Allow trash with linked published products, as the prototype does: this conflicts with the §5 rule against deleting a parent still needed by published products, and would leave live product pages pointing at a hidden brand.
- Lock the global Owner role like the identity, settings and delivery configuration mutations: catalogue edits are frequent Staff work, and a per-actor share lock gives the same protection against permission changes without serializing all catalogue writes.
- Hard delete from the trash view: architecture forbids this outside the step-51 Owner purge.

## Consequences

- Categories (43) and products (44) reuse `lockCatalogueActor`, the error classes and this transaction shape.
- `publishedProductCount` is a display aid only; the server check is authoritative.
- `catalog.changed` has no consumers yet. Storefront revalidation (step 52) attaches with a backfill decision.
- Deploy migration `20261010000500_catalogue_parents` before these endpoints. It has not been applied to the shared dev database.
