# 0011 — Typed versioned configuration without production defaults

- Date: 2026-10-10
- Status: accepted
- Step(s): 38

## Context

Store/contact/notification/WhatsApp settings need Owner-only updates with versions and audit. BI-01 brand/contact, BI-09 WhatsApp number/wording and remaining BI-07 sender/recipients are unanswered. The schema/API can be implemented independently, but prototype values cannot become real configuration or activate customer communications.

## Decision

- Introduce additive `settings`: immutable unique key, JSONB object or JSON-null value, positive version, updating staff FK (restrict deletion/update), DB-clock timestamp. Keys for this step are `store`, `contact`, `notifications`, `whatsapp`; no seeded data. Future delivery/age/tax settings require their own reviewed schema/contract expansion.
- `GET /v1/admin/settings` returns the four typed groups, including explicit missing `value:null`, version 0 and null updater/time. `PATCH` replaces one group via strict discriminated `{key, version, value}`. Version 0 creates only an absent key; actual writes start at 1. Existing keys require the current version; stale requests return 409. Current-value no-op preserves timestamp/version/audit; null clears configuration without deleting its history/aggregate.
- Store: bounded name, lower-case hostname (no scheme/path/credentials), nullable legal name. Contact: nullable validated email/E.164 phone/address/opening hours/footer/social HTTPS URLs without credentials. Notifications: in-app boolean and new-order email toggle/bounded case-insensitively unique recipients; enabled email requires at least one recipient. Low-stock/daily email remain deferred per BI-07/ADR 0004. WhatsApp: nullable E.164 number and bounded plain-text templates, supporting only `{{store_name}}`, `{{order_number}}`, `{{status}}`, `{{total}}`, `{{support_phone}}`; arbitrary placeholders/braces rejected. URI/text escaping is required when link construction is implemented (step 90); storing text never establishes a sent message.
- Require fresh active `settings.manage` (Owner launch seed). Writes take Owner-role guard, actor row share lock, then configuration key lock, stabilizing authority against concurrent role/security changes. A missing-row sentinel inserted inside the unit of work permits safe creation/version checks; it rolls back on conflict or any audit/event failure. Single-key commands fit the sorted settings-key resource order; future multi-key commands must sort keys and preserve the complete architecture lock order.
- Mutation, safe metadata-only audit and IDs-only `settings.updated` outbox commit atomically. Audit records key/version/configured state, never contact/recipient/template values. New event has no consumers/backfill. Read/write responses are private/no-store, strictly serialized; no public configuration endpoint. Write IP/actor budgets are separate, 30/hour, fail closed on shared limiter outage.
- No SMTP/Resend keys/provider changes in settings. Saving `enabled` and recipient values does not activate email delivery in this step; existing environment/default-off/staging allowlist safeguards stay authoritative. No WhatsApp automation/API. Real values and future delivery consumers need approved client inputs and release evidence.

## Alternatives considered

- Seed prototype contact/recipients/templates — would mistake demo data for business approval.
- Arbitrary key/value JSON or upsert without expected version — unsafe mass assignment and lost concurrent edits.
- Audit full JSON configuration — leaks contact/recipient/template content into audit retention.

## Consequences

Backend settings configuration is ready for step 40 forms. Step 39 introduces delivery areas/fee/ETA, still waiting on BI-03 for approved real values. The additive migration must be deployed before enabling these endpoints; no live migration was run here. Business approvals, production bootstrap, email/WhatsApp link wiring and step-37 browser QA remain open. This does not close M3.
