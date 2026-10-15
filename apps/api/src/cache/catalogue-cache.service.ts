import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { createLogger, errorSummary } from "@ih/logger";
import {
  LocalCache,
  ReadThroughCache,
  SharedCache,
  type CacheBackend,
  type LocalCacheStats,
} from "@ih/platform";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { API_ENV, CACHE_REDIS } from "../infra/tokens";

/** Bump when the shape of any cached catalogue value changes, so releases never share entries. */
export const CATALOGUE_CACHE_VERSION = 2;
/** One shared value may not take more than this share of a replica's byte budget. */
const MAX_SHARED_VALUE_BYTES = 1024 * 1024;

/**
 * The catalogue cache owner (roadmap step 52, ADR 0022). Budget profile: a bounded in-process
 * LRU in this single API process. Replicated profile: the separate cache Redis, with the same
 * bounded LRU as outage fallback. Only non-personal published catalogue data belongs here, and
 * callers authorize (age gate) before reading it. Never a correctness authority: checkout and
 * admin reads use PostgreSQL.
 */
@Injectable()
export class CatalogueCacheService {
  private readonly local: LocalCache;
  private readonly cache: ReadThroughCache;
  private readonly log;
  private lastInvalidatedAt: number | undefined;

  constructor(@Inject(API_ENV) env: ApiEnv, @Inject(CACHE_REDIS) redis: Redis | null) {
    this.log = createLogger({ service: "api-catalogue-cache", level: env.LOG_LEVEL });
    const ttlMs = env.CATALOG_CACHE_TTL_SECONDS * 1000;
    this.local = new LocalCache({
      ttlMs,
      maxEntries: env.CATALOG_CACHE_MAX_ENTRIES,
      maxBytes: env.CATALOG_CACHE_MAX_BYTES,
    });
    let backend: CacheBackend = this.local;
    if (env.RATE_LIMIT_PROFILE === "replicated") {
      if (!redis) throw new Error("replicated catalogue cache needs CACHE_REDIS_URL");
      const connected = async () => {
        if (redis.status === "wait" || redis.status === "end") await redis.connect();
        return redis;
      };
      backend = new SharedCache({
        redis: {
          get: async (key) => (await connected()).get(key),
          set: async (key: string, value: string, mode?: "PX", ttl?: number) =>
            mode && ttl !== undefined
              ? (await connected()).set(key, value, mode, ttl)
              : (await connected()).set(key, value),
        },
        fallback: this.local,
        ttlMs,
        namespace: `ih:cat:v${CATALOGUE_CACHE_VERSION}`,
        maxValueBytes: Math.min(MAX_SHARED_VALUE_BYTES, env.CATALOG_CACHE_MAX_BYTES),
        newGeneration: randomUUID,
        onUnavailable: (error) =>
          this.log.warn({ degraded: true, ...errorSummary(error) }, "shared cache unavailable"),
      });
    }
    this.cache = new ReadThroughCache({
      backend,
      maxConcurrentLoads: env.CATALOG_CACHE_MAX_CONCURRENT_MISSES,
      maxQueuedLoads: env.CATALOG_CACHE_MAX_QUEUED_MISSES,
    });
  }

  /**
   * `key` is built server-side from validated, bounded input. `load` reads PostgreSQL and
   * returns JSON-safe data. Throws `CacheOverloadedError` when the miss queue is full.
   */
  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.cache.getOrLoad(`v${CATALOGUE_CACHE_VERSION}:${key}`, load);
  }

  /** Drops every entry. Rejects when the shared store could not be told (caller retries). */
  async invalidate(): Promise<void> {
    await this.cache.invalidateAll();
    this.lastInvalidatedAt = Date.now();
  }

  /**
   * Post-commit, best effort: this process is correct immediately; the durable worker effect
   * retries the call and the TTL bounds anything both miss.
   */
  invalidateAfterCommit(): void {
    this.invalidate().catch((error: unknown) =>
      this.log.warn(errorSummary(error), "post-commit cache invalidation failed"),
    );
  }

  stats(): LocalCacheStats & { readonly lastInvalidatedAt: number | undefined } {
    return { ...this.local.stats(), lastInvalidatedAt: this.lastInvalidatedAt };
  }
}
