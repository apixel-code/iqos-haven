# 0012 — Approved Dubai areas and one versioned flat delivery policy

- Date: 2026-10-10
- Status: accepted
- Step(s): 39

## Context

The architecture requires approved Dubai coverage, one flat delivery fee and ETA, with free delivery off initially. BI-03 is unanswered. Step 39 supplies configuration and area administration independently of those values; public checkout/pricing and step-40 forms are later work.

## Decision

- Add `delivery_areas` with UUIDv7 ID, unique immutable lower-case code, case-insensitive unique bounded name, Dubai-only immutable emirate, active flag, positive version, updating staff FK and DB-clock timestamp. The API accepts complete name/active replacements; deactivation preserves stable identity/history. No delete endpoint or per-area fee. No prototype areas or fee/ETA are seeded. Operators must obtain approved coverage before activating real areas; selecting an area is not proof of an address inside the boundary.
- Add the `delivery` settings key, independently authorized by `delivery.manage`. Keep step-38 settings groups and `settings.manage` API unchanged. Value is either unconfigured JSON null or a strict object with `flatFeeFils` (integer 0–1,000,000,000), `etaText` (1–500 trimmed characters) and `freeThresholdFils:null`. Bounds are defensive limits, not suggested business values. The only supported threshold state in this launch slice is disabled; a future approval and reviewed policy/UI extension are necessary to enable it. The fee can be explicitly configured as zero, but is never guessed from missing configuration. DB constraints also reject malformed delivery configuration.
- Owner launch grants authorize `GET/POST /v1/admin/delivery-areas`, `PATCH /v1/admin/delivery-areas/:id` and `GET/PATCH /v1/admin/delivery-areas/configuration`. No public read/selection route before the age-gated commerce surface. List uses bounded ID keyset pagination (default 50, max 100). Strict body/query/path contracts, private/no-store serialization, admin Origin/JSON controls and 30/hour IP/actor fail-closed mutation budgets apply.
- Mutations take the common Owner-role guard and actor share lock, recheck active permission and then lock the affected configuration/area. Configuration version 0 creates an absent row at version 1; an in-transaction sentinel rolls back on any failure. Area create starts at 1 and unique code/name conflicts return 409. Updates require the current version; stale versions return 409, missing areas 404. Genuine no-ops preserve timestamp/version/audit. JSON null clears configuration while preserving the versioned row. Area code/emirate/ID cannot be changed, even by direct SQL updates.
- Save mutation, version-only/configured-state audit and IDs-only `delivery.area_updated` / `delivery.configuration_updated` outbox in one transaction. Events have no consumers or backfill; name/ETA/fee values are not copied into audit or events. No network I/O in the transaction.
- `deliveryForArea` is the pure launch rule: missing/inactive/non-Dubai area is unavailable, missing configuration fails closed, otherwise use the server flat integer fee/ETA. Internal `lockDeliverySelection` requires a tracked unit of work and retains `FOR SHARE` on configuration then area until commit. It returns stable area/configuration versions and snapshot fields, allowing later server quotes/order creation to enforce re-acceptance. Callers must first take earlier resource locks and must not acquire earlier groups afterwards. No cart total, quote fingerprint, stock reservation or order persistence is introduced here.

## Alternatives considered

- Import the 45 prototype areas and demo fees — would misrepresent unanswered BI-03 as approval.
- Put fee/ETA on each area — conflicts with the one-flat-fee launch policy.
- Read active state without locks — can accept a fee or area concurrently changed before order snapshotting.
- Hard-delete areas or clear configuration by deleting rows — loses stable historical identity and version continuity.

## Consequences

Schema/API and internal selection rules are ready; real configuration remains blocked on BI-03. Deploy additive migration `20261010000300_delivery_configuration` before these endpoints (not run on the live/dev database here). Configuration alone does not enable checkout or close M3. Step 40 builds admin forms and auth/RBAC acceptance; step-37 browser QA remains pending. Public delivery choices, quote re-acceptance and order snapshots are verified in their later roadmap steps, not claimed by these backend tests.
