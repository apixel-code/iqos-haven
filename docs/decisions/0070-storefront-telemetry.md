# 0070 — Storefront telemetry: batching and overload

- Date: 2026-10-16
- Status: accepted
- Step(s): 104 (server side: ADR 0069)

## Context

Roadmap step 104 has these done conditions:

- Sampling and dropping are allowed.
- Telemetry can never block checkout.
- The wishlist stays device-only.

## Decision

**Queue** (`apps/storefront/lib/telemetry/queue.ts`, pure, unit tested). Events wait in memory, never in device storage, at most 100. When the queue is full, new events are dropped.

A batch of at most 20 leaves:

- 5 seconds after the first waiting event;
- at once when 20 are waiting;
- with `keepalive` when the page is hidden or left.

What happens to a sent batch depends on the answer:

| Answer                                             | Result                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| 202                                                | Done.                                                                            |
| 5xx or a network failure                           | Sent once more with the same event IDs, which the API counts once, then dropped. |
| 429 or 503                                         | Everything waiting is dropped, and nothing is recorded or sent for a minute.     |
| Any other 4xx, or a body the contract would refuse | Dropped without retrying.                                                        |

Sampling per type is supported; every type is at rate 1 at launch.

**Never in the way.**

- `track()` returns at once, never throws, and is never awaited.
- On `/checkout`, `/order-confirmation` and `/review` nothing is recorded or sent. Events still waiting when the shopper reaches one of these pages are dropped.
- Leaving a page sends one batch at most. Events beyond that, or arriving while a batch is in flight, may be lost. This is accepted under the best-effort policy.

**Events.**

| Event                             | Sent from                  | What it carries                                                     |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `search`                          | The first page of a search | Term (at most 100 characters) and total                             |
| `product_view`                    | The product page           | Product slug                                                        |
| `cart_add`, `cart_remove`         | The cart store             | The units that really went in or out (add, quantity change, remove) |
| `wishlist_add`, `wishlist_remove` | The saved list             | Product slug                                                        |

Emptying the cart after an order sends nothing. The saved list itself stays on the device; only the anonymous add or remove is reported.

A search term that may be personal (see ADR 0069) is normalized in the browser and sent as `null`, so it never leaves the device. The API applies the same rule again.

Wishlist add and remove carry the rotating anonymous ID, so the server could see one browser's saves within a day. They are used only for daily totals (step 106). Searches carry no anonymous ID.

**Anonymous ID:** a random UUID stored in `ih_anon_v1` and replaced after 24 hours. It is device state like the cart, and it is not personal data. If storage is blocked, events go without one.

## Consequences

- No consent banner is built. Telemetry carries no personal data and no third-party script. If the client's legal review asks for consent, it becomes a switch in front of `track()`.
- Step 106 counts these events in the daily tables.
