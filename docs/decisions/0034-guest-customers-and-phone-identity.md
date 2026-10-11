# 0034 — Guest customers, saved addresses and the phone identity

- Date: 2026-10-11
- Status: accepted
- Step(s): 65 (validation rules: 66; order snapshots: 73; order transaction: 75–76; admin customer views: 90)

## Context

Roadmap step 65: `customers`, `customer_addresses` and a customer service, with phone normalization and uniqueness, no customer login, and old order snapshots independent of the customer record. Architecture §5 defines the customer as "UUID identity, normalized unique phone_e164, display name, first_order_at, operational no-show flag; no customer authentication" and the address as "not the source for past orders".

## Decision

**A customer is a phone number.** `customers.phone_e164` is unique, checked against the E.164 shape in the database and immutable (trigger): a different phone is a different customer. There is no credential, email or session column, and the integration test pins the exact column list so one cannot be added unnoticed.

**One normalization rule, in `@ih/domain` (`normalizePhone`).**

| Typed                                                      | Read as                       |
| ---------------------------------------------------------- | ----------------------------- |
| `050…`, `50…` (9 digits), `971…`, `+971…`, `00971…`        | UAE number, `+971…`           |
| `+971 (0)50…`, `+971 050…`                                 | Same, trunk zero dropped      |
| Arabic-Indic or Persian digits; spaces, dots, dashes, `()` | Same as the ASCII form        |
| `+CC…` or `00CC…` of another country                       | That number, E.164 8–15       |
| Anything else                                              | Refused (`InvalidPhoneError`) |

A UAE number must be a mobile (`5` + 8 digits) or a geographic landline; toll-free and service numbers are refused. A number without a country code is never guessed to be foreign. Known limit: a trunk zero typed after a non-UAE country code (`+44 (0)20 …`) is not repaired, so that spelling is a separate identity.

**Finding or creating the customer (`lockCustomerForOrder`).** Inside a unit of work only: `INSERT … ON CONFLICT (phone_e164) DO NOTHING`, then `SELECT … FOR UPDATE`. Under Read Committed the insert waits for a concurrent insert of the same phone instead of failing the transaction, and the locking read then sees the winner, so concurrent first orders of one phone share one customer without a retry. The lock is the "customer" group of the resource order and is held until commit.

**Display name.** The latest typed name replaces the display name (version + 1). A guest does not prove they own a phone, so the display name is a convenience label only: an order shows its own snapshot name (step 73), never this one.

**Addresses are immutable rows.** A saved address is never updated (trigger, and the runtime role has no UPDATE on the table); a correction is a new row, and saving an identical address returns the existing row. An address references a delivery area but saving does not decide deliverability; `lockDeliverySelection` does. In a transaction that uses both, `saveCustomerAddress` runs after `lockDeliverySelection`, because the insert takes a key-share lock on the area row.

**No deletion at runtime.** The runtime role has no DELETE or TRUNCATE on either table, and the foreign keys are RESTRICT. Retention and anonymization (architecture "Personal data and residency") will be a separate reviewed path once agreed with the client.

**No audit or outbox entry from these primitives.** They run only inside the owning order/checkout transaction, which writes its own audit entry and events atomically (steps 75–76). Nothing else may call them.

**Bounds.** The database holds the storage bounds (name 100; building 150, unit 50, street 150, Makani exactly 10 digits, notes 500; type apartment/villa/office). Text is NFC-normalized, whitespace-collapsed, and refused if it contains control or invisible format characters (joiners excepted). Per-type rules such as "an apartment needs a unit" are step 66.

## Not built here

- Public validators and error messages for checkout input (step 66); any API route or UI.
- Order tables and their customer/address snapshots (step 73); stamping `first_order_at` from an order (`markCustomerFirstOrder` exists, step 76 calls it).
- Setting the no-show flag, customer history and spend views (step 90); customer export (step 111).
- Merging two customers, changing a phone, retention/anonymization.

## Alternatives considered

- **Unique index on a normalized expression of a free-text phone.** Rejected: one normalizer in code plus a strict stored shape is simpler to test and to reuse for manual orders.
- **Insert, catch the unique violation, re-read.** Rejected: a failed statement aborts the transaction and would force a whole-transaction retry for the common repeat customer.
- **Keeping the first name ever typed.** Rejected: staff would see a stale name; the snapshot on each order already keeps history.
- **Mutable address rows.** Rejected: an immutable row means an address ID always names the same place, at the cost of extra rows.

## Consequences

- Whether orders from non-UAE numbers and UAE landlines are wanted is a client decision; step 66 can narrow the rule without a schema change.
- Customers typing a foreign number in local form are refused; the checkout form must say that a country code is needed.
- Tests for step 73–76 must show an audit entry and events for a transaction that renames a customer or adds an address, and must run address saving against concurrent area and delivery-setting edits.
