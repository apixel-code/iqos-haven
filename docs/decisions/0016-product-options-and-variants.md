# 0016 — Product options and variants: locked structure, exact combinations, one active default

- Date: 2026-10-10
- Status: accepted
- Step(s): 45 (used by 46–47, 51, 56–60, 73–76)

## Context

Roadmap step 45 asks for real flavour, nicotine and colour combinations from launch. A product with no options must have only its default variant. Step 41 already enforces several rules in the database:

- canonical attributes and a generated option signature that is unique per product;
- globally unique uppercase SKUs;
- at most one default variant per product;
- zero starting stock, with stock changes going through the ledger only.

Variants are referenced by stock movements and orders, so they are never deleted. The prototype has no variant editor ("Future option").

## Decision

**API.** All routes return the product's full option and variant snapshot (product version, options, variants with read-only stock), so the editor never mixes versions.

- Routes:
  - `GET /v1/admin/products/:id/variants` (`catalog.read`)
  - `PUT /v1/admin/products/:id/options` (`catalog.write`)
  - `POST /v1/admin/products/:id/variants` (`catalog.write`)
  - `PATCH /v1/admin/products/:id/variants/:variantId` (`catalog.write`)
- Options are `flavour`, `nicotine` and `colour`, each with 1–50 unique values.
  - Values are trimmed and lower-cased, matching the DB canonical form.
  - Options are product data: replacing the set requires the expected product version and increases it.
- SKUs are uppercased and pattern-checked. Stock never appears in request bodies; unknown fields get 400.

**Transactions.** One transaction per mutation: actor `FOR SHARE` and permission recheck → product `FOR UPDATE` → affected variants in sorted ID order. Because the product row lock serializes every option and variant change of that product, the cross-row rules below cannot race.

- **Option names** may change only while the product has no variants. Values may be added at any time, and removed only when no variant uses them. Otherwise the request gets 409 `OPTIONS_IN_USE`.
- **Combinations:** a variant's attributes must name exactly the product's options, each with an allowed value. A product without options gets one variant with `{}`. Otherwise the request gets 409 `INVALID_COMBINATION`. Duplicate combinations and SKUs get 409 `DUPLICATE`.
- **Default variant:**
  - The first variant becomes the default and must be active.
  - Setting `isDefault: true` on another active variant moves the default atomically: the old default is cleared and its version bumped.
  - The current default cannot be unset or deactivated directly; that gets 409 `DEFAULT_REQUIRED`.
- **Lifecycle:** attributes are immutable after creation. Variants are deactivated, never deleted. Trashed products are read-only (409 `TRASHED`).
- **Audit and events:** audit entries are written atomically with the change.
  - `catalog.product_options_updated` lists the option values before and after. These are catalogue data, not personal data.
  - `catalog.variant_created` and `catalog.variant_updated` record SKU, attributes, price override, threshold, active and default.
  - Every option or variant change emits one product-level `catalog.changed` event (`entityType: "product"`), so storefront revalidation (step 52) maps it to the product page.
- **Variant PATCH** locks the target and the current default (sorted IDs) before reading them, because stock-ledger writers update variant rows without the product lock.
- **The snapshot read** runs in one short REPEATABLE READ transaction, so version, options and variants come from the same moment.

**Admin.** The product editor gains an "Options & variants" card:

- option value lists;
- "Add N missing combinations", which creates the missing variants with SKUs suggested from slug and values plus a position suffix (`-V01`), kept within 64 characters (the server checks global uniqueness);
- per-variant SKU, AED price override (converted to fils), low-stock threshold, active and default controls;
- a single-variant button for products without options.

Saving options reloads the product only when the product version actually changed.

## Alternatives considered

- A full replace of options and variants in one request: this hides deletes. Variants carry stock and order history and must only be deactivated.
- Free option names: the launch scope names three options. More can be added with a contract change.
- Allowing option-structure changes with existing variants: every existing variant would become an invalid combination. Before launch, create a new product instead.

## Consequences

- Step 46/47 stock writes lock the product (or its parents per the lock order) and then variants in sorted order, using the ledger flag.
- Publishing (step 51) must require at least one active variant, and an active default.
- Storefront selection (steps 56–60) and order lines (73–76) reference variants by ID and snapshot SKU, attributes and price.
