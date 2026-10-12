# 0043 — Idempotent commands: claim, replay, conflict and expiry

- Date: 2026-10-12
- Status: accepted
- Step(s): 74 (order creation that uses it: 76; store route and its error mapping: 77; cancel and stock commands: 85–86)

## Context

Roadmap step 74: `idempotency_records` and an idempotency service; scope, key and hash unique; the same payload replays, a changed payload conflicts; rollback then winner lookup. Architecture §7: claim the key first in the transaction; a concurrent request waits or gets a bounded retryable "in progress"; same hash replays the same success, a different hash is `409 IDEMPOTENCY_CONFLICT`; keep the answer at least 24 hours; after that never accept the key as new; a rolled-back attempt may retry; the key is a bearer-like secret.

## Decision

**The claim is the first statement of the command's transaction** (the first group of the resource order), and the record lives and dies with that transaction:

| Situation                                         | Outcome                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| New key                                           | The command runs; its answer is stored in the same transaction                                                        |
| Same key, same payload                            | The stored answer is returned; nothing runs again                                                                     |
| Same key, different payload                       | `IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`)                                                                   |
| Same key while the first attempt is still running | Waits up to `waitMs` (default 3 s), then `IdempotencyInProgressError` (`IDEMPOTENCY_IN_PROGRESS`): retry the same key |
| The first attempt rolls back while another waits  | The waiter becomes the owner and runs                                                                                 |
| The command fails                                 | No record is left; the key can be used again, also with a corrected payload                                           |
| Same key after its answer expired                 | `IdempotencyExpiredError` (`CHECKOUT_RECOVERY_REQUIRED`), with the resource it created; never a new command           |

**How the claim avoids a rollback.** `INSERT … ON CONFLICT (scope, key_hash) DO NOTHING` under Read Committed waits for an in-flight transaction that holds the same key. If that one commits, nothing is inserted and the next statement reads the winner's row; if it rolls back, the insert proceeds. This gives the outcomes the architecture describes for "roll back, then read the winner" without a failed statement. The wait is bounded with `lock_timeout` for that statement only; the previous setting is put back afterwards.

**What is stored.** A scope (endpoint namespace, plus the principal for staff commands), the SHA-256 of scope and key, the SHA-256 of the canonical request, the answer (a JSON object of at most 16,000 characters), the resource it created, and an expiry (default 24 hours, bounded 60 seconds to 30 days). The key itself is never stored or logged.

**Database guarantees.** One record per scope and key; a claim cannot be committed without an answer; key, payload and expiry never change; the answer is written once; only an expired record can be deleted; the runtime role cannot truncate.

**Canonical payload (`canonicalPayloadHash`).** Plain JSON with object keys sorted; array order kept; only strings, booleans, null and safe integers; anything else (a float, `undefined`, an array hole, a date, a function) is a programming error and throws. The caller hashes the normalized request (merged lines, normalized phone and address, coupon, accepted quote fingerprint, confirmations), so two spellings of one order are one payload.

**Keys.** 22 to 128 URL-safe characters, made by the client and meant to be random. Only the shape can be checked. Because of that, a stored answer holds nothing that a guessed key should not reveal: no phone, name or address, no token, cookie or capability, no access link, and nothing that goes stale.

**Cleanup.** `deleteExpiredIdempotencyRecords` removes expired records in batches. After cleanup this ledger no longer remembers the key, so a command with a permanent record of its own must check it: order creation looks up `orders (creation_scope, creation_key_hash)` right after the claim, using the same `idempotencyKeyHash` and scope, and answers `CHECKOUT_RECOVERY_REQUIRED` if an order exists.

## Not built here

- Any caller: order creation (step 76) and its HTTP mapping with `Retry-After` (step 77).
- A scheduled job that calls the cleanup (wired with the first caller).
- Encrypted replayable confirmation material (step 79).
- A server-side pepper for key hashes.

## Alternatives considered

- **Insert, catch the unique violation, roll back, read in a new transaction.** Rejected: the failed statement aborts the transaction and the command would need a second transaction for a result `ON CONFLICT DO NOTHING` gives in one.
- **A visible "in progress" row committed before the work.** Rejected: a crash would leave a stuck claim that needs a recovery process; here a crash simply rolls back.
- **HMAC of the key with a server pepper.** Not done now: it adds a secret to manage and must match the order's permanent hash. The rule about what an answer may contain covers the risk; can be added later.

## Consequences

- A duplicate request holds a database connection for up to `waitMs` while it waits.
- After a deadlock retry the command body runs again in a new transaction, so it must change nothing outside the transaction.
- The API layer must answer `IDEMPOTENCY_IN_PROGRESS` and exhausted contention with a retryable status.
