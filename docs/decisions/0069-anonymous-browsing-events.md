# 0069 — Anonymous browsing events

- Date: 2026-10-16
- Status: accepted
- Step(s): 103 (client batching: 104; rollups: 106)

## Context

Roadmap step 103 asks for a bounded, anonymous browsing-event schema and its collection, with these done conditions:

- Search, product view, cart and wishlist types.
- Batch bounds.
- No phone, address or name.

Architecture §5 lists `events` (ID, type, bounded payload, an optional short-lived anonymous ID, a timestamp). §12 lists `POST /api/v1/store/events` (age where applicable, bounded schema and batch, rate limit, no customer PII). §13 says browsing analytics are best effort and never on the commerce path. BI-08 keeps raw events for 90 days.

## Decision

**Table `events`** (migration `20261016000100_browsing_events`):

- The ID comes from the client, so a resent batch is counted once (`ON CONFLICT DO NOTHING`).
- The type is one of six: `search`, `product_view`, `cart_add`, `cart_remove`, `wishlist_add`, `wishlist_remove`.
- The payload is an object of at most 512 bytes.
- An optional `anonymous_id`.
- `received_at`, the server time; the client's clock is not trusted.
- No IP, user agent, cookie, customer or order is stored.

**Payloads** (`packages/contracts/src/telemetry.ts`, strict shapes):

| Type                                              | Payload                             |
| ------------------------------------------------- | ----------------------------------- |
| `search`                                          | Normalized term and result count    |
| `product_view`, `wishlist_add`, `wishlist_remove` | The product ID                      |
| `cart_add`, `cart_remove`                         | Product ID, variant ID and quantity |

- The storefront sends product slugs. The API resolves them, including former slugs, to visible products, and drops anything else.
- Variants must be active on a visible product.
- A search term is normalized (NFKC, so Arabic-Indic digits count as digits), lower-cased, and cleaned of controls and hidden marks.
- A term is stored as `null`, with the search still counted, when it has an "@", more than five digits of any script, more than four words or more than 40 characters. Such a term may be a phone number, an email, a name or an address.
- Search rows never carry the anonymous ID, so one browser's searches cannot be read as a history.
- A short product search that is also a name (for example "john") can still be stored. This residual risk is accepted: no other field links it to a person.

**Route** `POST /v1/store/events`:

- Behind the age ticket and the store Origin and JSON rules.
- Limited to 60 batches per minute per address, with a local fallback when the shared limiter is down.
- At most 20 events per batch. A body over 8 KB is refused with 413 before it is read.
- It always answers 202 with `stored`, `duplicate` and `dropped`.
- A process writes at most 2 batches at once; a batch beyond that is dropped, not queued. A database error drops the batch and is logged without its content.
- One insert statement with a 2-second statement timeout, and no transaction around anything else. Slug lookups prefer the current slug over a matching former one.
- A chunked body without a length is bounded by the global 32 KB limit and the 20-event contract, and gets a 400.

**Retention:** the daily worker job `analytics.events_cleanup` deletes raw events older than 90 days, in batches of 5000 and at most 200,000 per run. It warns when it leaves a backlog. The runtime role can insert and delete, but cannot update or truncate.

## Consequences

- Step 104 adds the storefront batching (sampling, dropping under load, never blocking checkout). Step 106 rolls these up into `search_daily` and `wishlist_daily`.
- `docs/data-flows.md` (architecture §11) does not exist yet. When it is written, this flow is: no personal data, stored in the primary database, kept 90 days, Owner analytics only.
