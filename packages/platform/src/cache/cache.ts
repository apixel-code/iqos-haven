/**
 * Disposable catalogue read cache (architecture §9 "Cache contract", ADR 0022). It is never a
 * correctness authority: eviction, restart or an outage only cause ordinary database misses.
 *
 * Invalidation is coarse on purpose: any committed catalogue change starts a new generation, so
 * every older entry is unreachable. A write carries the generation its load started under and is
 * dropped if that generation has ended, so a slow load can never re-insert pre-change data.
 */
export const MAX_CACHE_TTL_MS = 60_000;

export interface CacheRead {
  readonly value: string | undefined;
  /** Opaque; pass back to `write` so a load that raced an invalidation is discarded. */
  readonly generation: string;
}

export interface CacheBackend {
  read(key: string): Promise<CacheRead>;
  write(key: string, value: string, generation: string): Promise<void>;
  /** Makes every existing entry unreachable. Rejects if a shared store could not be told. */
  invalidateAll(): Promise<void>;
}

export interface LocalCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  /** Bound on the summed UTF-8 size of keys and values. */
  readonly maxBytes: number;
  readonly now?: () => number;
}

export interface LocalCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

interface Entry {
  readonly value: string;
  readonly bytes: number;
  readonly expiresAt: number;
}

function ttl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CACHE_TTL_MS)
    throw new RangeError("Cache TTL must be between 1 ms and 60 s");
  return ttlMs;
}

/** In-process LRU with entry, byte and TTL bounds: the budget profile's sole cache owner. */
export class LocalCache implements CacheBackend {
  // Map iteration order is insertion order; a hit re-inserts, so the first key is the LRU.
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private generation = 0;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly options: LocalCacheOptions) {
    this.ttlMs = ttl(options.ttlMs);
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
      throw new RangeError("Cache needs a positive entry bound");
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)
      throw new RangeError("Cache needs a positive byte bound");
    this.now = options.now ?? Date.now;
  }

  read(key: string): Promise<CacheRead> {
    const generation = String(this.generation);
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.remove(key, entry);
      this.misses += 1;
      return Promise.resolve({ value: undefined, generation });
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return Promise.resolve({ value: entry.value, generation });
  }

  write(key: string, value: string, generation: string): Promise<void> {
    if (generation !== String(this.generation)) return Promise.resolve();
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    // An entry that cannot fit is simply not cached; it must not flush everything else.
    if (bytes > this.options.maxBytes) return Promise.resolve();
    this.entries.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.options.maxEntries && this.bytes <= this.options.maxBytes)
        break;
      this.remove(oldest, entry);
      this.evictions += 1;
    }
    return Promise.resolve();
  }

  invalidateAll(): Promise<void> {
    this.generation += 1;
    this.entries.clear();
    this.bytes = 0;
    return Promise.resolve();
  }

  stats(): LocalCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

/** Minimal Redis surface (ioredis-compatible) so this package does not own a client. */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface SharedCacheOptions {
  readonly redis: RedisCacheClient;
  /** Bounded local cache used while the shared store is unreachable. */
  readonly fallback: LocalCache;
  readonly ttlMs: number;
  /** Key namespace; include the deployment/schema version so releases never share entries. */
  readonly namespace: string;
  readonly maxValueBytes: number;
  readonly newGeneration: () => string;
  readonly onUnavailable?: (error: unknown) => void;
}

const LOCAL_PREFIX = "local:";

/**
 * Replicated profile: separate cache Redis shared by every API replica. One generation key
 * coordinates invalidation; entries live under it and expire by TTL, so eviction is harmless.
 * While Redis is unreachable each replica serves from its own bounded fallback; staleness is
 * then bounded by the TTL, not by coordinated invalidation.
 */
export class SharedCache implements CacheBackend {
  private readonly ttlMs: number;

  constructor(private readonly options: SharedCacheOptions) {
    this.ttlMs = ttl(options.ttlMs);
    if (!/^[a-z0-9:_-]{1,64}$/.test(options.namespace))
      throw new RangeError("Invalid cache namespace");
  }

  private get generationKey(): string {
    return `${this.options.namespace}:gen`;
  }

  private entryKey(generation: string, key: string): string {
    return `${this.options.namespace}:${generation}:${key}`;
  }

  async read(key: string): Promise<CacheRead> {
    try {
      const generation = (await this.options.redis.get(this.generationKey)) ?? "0";
      const value = await this.options.redis.get(this.entryKey(generation, key));
      return { value: value ?? undefined, generation };
    } catch (error) {
      this.options.onUnavailable?.(error);
      const local = await this.options.fallback.read(key);
      return { value: local.value, generation: LOCAL_PREFIX + local.generation };
    }
  }

  async write(key: string, value: string, generation: string): Promise<void> {
    if (generation.startsWith(LOCAL_PREFIX))
      return this.options.fallback.write(key, value, generation.slice(LOCAL_PREFIX.length));
    if (Buffer.byteLength(value, "utf8") > this.options.maxValueBytes) return;
    try {
      // Written under the generation the load started in: if it has ended, nobody reads this.
      await this.options.redis.set(this.entryKey(generation, key), value, "PX", this.ttlMs);
    } catch (error) {
      this.options.onUnavailable?.(error);
    }
  }

  async invalidateAll(): Promise<void> {
    // Local first: this replica is correct even if the shared store cannot be reached.
    await this.options.fallback.invalidateAll();
    await this.options.redis.set(this.generationKey, this.options.newGeneration());
  }
}

/** The bounded miss queue is full; callers answer 503 rather than pile onto the database. */
export class CacheOverloadedError extends Error {
  constructor() {
    super("Cache miss queue is full");
  }
}

export interface ReadThroughOptions {
  readonly backend: CacheBackend;
  /** Loads (database misses) allowed to run at once. */
  readonly maxConcurrentLoads: number;
  /** Loads allowed to wait for a slot before new misses are refused. */
  readonly maxQueuedLoads: number;
}

/**
 * Read-through access with one in-flight load per key and a bounded number of concurrent
 * misses. Values are stored as JSON, so every caller gets its own copy.
 */
export class ReadThroughCache {
  private flights = new Map<string, Promise<string>>();
  private readonly waiters: Array<() => void> = [];
  private running = 0;

  constructor(private readonly options: ReadThroughOptions) {
    if (options.maxConcurrentLoads < 1 || options.maxQueuedLoads < 0)
      throw new RangeError("Invalid cache load bounds");
  }

  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.options.backend.read(key);
    if (cached.value !== undefined) return JSON.parse(cached.value) as T;
    // Flights are per generation: after another replica invalidates the shared store, a new
    // reader must not join a load that began before the change.
    const flightKey = `${cached.generation}\n${key}`;
    let flight = this.flights.get(flightKey);
    if (!flight) {
      const flights = this.flights;
      flight = this.load(key, load, cached.generation).finally(() => {
        if (flights.get(flightKey) === flight) flights.delete(flightKey);
      });
      flights.set(flightKey, flight);
    }
    return JSON.parse(await flight) as T;
  }

  /** Call after the mutation committed. Later readers never join a load that began before it. */
  async invalidateAll(): Promise<void> {
    this.flights = new Map();
    await this.options.backend.invalidateAll();
  }

  private async load<T>(key: string, load: () => Promise<T>, generation: string): Promise<string> {
    await this.acquire();
    try {
      const value = JSON.stringify(await load()) as string | undefined;
      if (value === undefined) throw new TypeError("Cache loaders must return JSON data");
      await this.options.backend.write(key, value, generation);
      return value;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.options.maxConcurrentLoads) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.options.maxQueuedLoads)
      return Promise.reject(new CacheOverloadedError());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    // Hand the slot straight to the next waiter so the running count never dips.
    const next = this.waiters.shift();
    if (next) next();
    else this.running -= 1;
  }
}
