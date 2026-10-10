# 0022 — Catalogue cache owner and publish invalidation

- Date: 2026-10-10
- Status: accepted
- Step(s): 52 (first reader: store catalogue API, step 58; content cache, step 97)

## Context

Roadmap step 52 asks for a bounded catalogue cache with internal invalidation: TTL and memory bounded, worker retries, no second persistent cache in the storefront, and a separate shared cache on the replicated profile. Architecture §9 fixes the contract: on the budget profile the API process is the sole cache owner, TTL is at most 60 seconds, publication invalidates locally after commit, and a durable worker effect retries an authenticated private invalidation call. Architecture §8 says adding a consumer to an event needs an explicit backfill decision.

No store read endpoint exists yet (step 58), so this step delivers the cache, its invalidation path and its guards; nothing customer-facing reads it yet.

## Decision

**Cache (`@ih/platform` `cache/cache.ts`).**

- `LocalCache`: in-process LRU bounded by entries, by summed UTF-8 bytes of keys and values, and by TTL. The constructor refuses a TTL above 60 s. A value larger than the whole budget is not cached.
- `SharedCache`: the replicated profile's backend on the separate cache Redis (`CACHE_REDIS_URL`, never the queue Redis). Entries live under a generation key and expire by TTL, so eviction is harmless. While Redis is unreachable each replica serves from its own `LocalCache`; staleness is then bounded by the TTL only.
- `ReadThroughCache`: one in-flight load per key, a bounded number of concurrent database misses, and a bounded wait queue. A full queue throws `CacheOverloadedError`; the store API maps it to 503 in step 58.
- Values are stored as JSON strings, so byte accounting is exact and callers cannot mutate a shared object.

**Invalidation is coarse.** Any catalogue change starts a new generation and every older entry becomes unreachable. A write carries the generation its load started under and is dropped if that generation ended, so a read that began before a commit can never be stored after it. The catalogue is small and a brand or category edit fans out to many products, so per-entity tags would add risk without a measurable gain.

**Three recovery layers, in order:**

1. The API drops its local cache after every mutating admin catalogue or gallery request settles (`CatalogueInvalidationInterceptor`). It also runs when the handler fails, because a handler can fail after its commit.
2. `catalog.changed` now requires the `storefront_revalidate` consumer. The worker sends a signed `POST /v1/internal/revalidate` (HMAC service auth from step 26, `worker` only). Any non-2xx answer or network failure is retried by the effect row; an exhausted budget leaves a dead effect to alert on. The call is idempotent.
3. The TTL (≤ 60 s) bounds anything both miss.

**Profile selection** reuses `RATE_LIMIT_PROFILE`: `budget` uses the local LRU, `replicated` uses the shared cache Redis. One switch describes one deployment shape.

**Backfill decision (architecture §8).** None. Events written before this step keep their empty consumer snapshot and stay completed. The cache starts empty with the process and every entry expires within 60 seconds, so no old event can leave stale data behind.

**Configuration.** `CATALOG_CACHE_TTL_SECONDS` (1–60), `CATALOG_CACHE_MAX_ENTRIES`, `CATALOG_CACHE_MAX_BYTES`, `CATALOG_CACHE_MAX_CONCURRENT_MISSES`, `CATALOG_CACHE_MAX_QUEUED_MISSES`. The worker needs `API_INTERNAL_URL` and its signing identity; the schema requires them in staging and production. Without them in local development the effect completes as `skipped:not_configured` and the TTL applies.

**Storefront.** It keeps no data cache. ESLint now rejects `next/cache`, `revalidate` exports/options, `cache: "force-cache"` and the `"use cache"` directive there. The consumer keeps its catalogue name `storefront_revalidate`, but it only calls the API: there are no Next tags to revalidate.

## Alternatives considered

- **Per-entity tags.** Rejected for launch: more invalidation paths to get wrong, for a catalogue that reloads in a few queries.
- **Invalidation only from the worker.** Rejected: publication would wait for relay latency. The architecture asks for local invalidation after commit.
- **Calling the cache from each service method.** Rejected: easy to forget on a new mutation. The interceptor covers a whole controller.
- **Queue Redis pub/sub or keys for cache data.** Rejected by architecture §8: queue memory is not a cache.

## Consequences

- Stock changes do not emit `catalog.changed`; displayed stock may lag by up to the TTL. Checkout reads transactional stock.
- A failed validation on a mutating admin request also drops the cache. This is an authenticated, rate-limited extra miss.
- The cache must hold only non-personal published catalogue data, and callers must authorize (age gate) before reading it. Step 58 owns the keys and that check.
- `CATALOGUE_CACHE_VERSION` in `apps/api/src/cache/catalogue-cache.service.ts` must be bumped when a cached shape changes.
- Invalidation lag is visible as the age of unfinished `storefront_revalidate` effects; an alert on it belongs to the observability step.
- On the replicated profile the worker call reaches one replica. The shared generation covers every replica's Redis reads; another replica's outage-fallback entries are bounded by the TTL only.
- If cache Redis evicts the generation key, entries of generation `0` become readable again until their TTL (≤ 60 s) ends.
- A local entry's TTL starts when it is stored, so data can be as old as the TTL plus its load time.
- Step 58 must not promise fresher availability than this: stock set/adjust routes deliberately carry no invalidation.
- A second API replica on the budget profile is not supported: switch to `replicated` first.
