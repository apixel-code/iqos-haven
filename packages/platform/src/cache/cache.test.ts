import { describe, expect, it } from "vitest";
import {
  CacheOverloadedError,
  LocalCache,
  ReadThroughCache,
  SharedCache,
  type RedisCacheClient,
} from "./cache";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}
const local = (options: Partial<ConstructorParameters<typeof LocalCache>[0]> = {}) =>
  new LocalCache({ ttlMs: 60_000, maxEntries: 100, maxBytes: 10_000, ...options });
async function put(cache: LocalCache, key: string, value: string) {
  await cache.write(key, value, (await cache.read(key)).generation);
}
const value = async (cache: LocalCache, key: string) => (await cache.read(key)).value;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("LocalCache", () => {
  it("refuses a TTL above 60 seconds and non-positive bounds", () => {
    expect(() => local({ ttlMs: 60_001 })).toThrow(RangeError);
    expect(() => local({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => local({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => local({ maxBytes: 0 })).toThrow(RangeError);
  });

  it("expires entries at the TTL and frees their bytes", async () => {
    const time = clock();
    const cache = local({ ttlMs: 1_000, now: time.now });
    await put(cache, "a", "one");
    time.advance(999);
    expect(await value(cache, "a")).toBe("one");
    time.advance(1);
    expect(await value(cache, "a")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("evicts the least recently used entry at the entry bound", async () => {
    const cache = local({ maxEntries: 2 });
    await put(cache, "a", "1");
    await put(cache, "b", "2");
    expect(await value(cache, "a")).toBe("1");
    await put(cache, "c", "3");
    expect(await value(cache, "b")).toBeUndefined();
    expect(await value(cache, "a")).toBe("1");
    expect(await value(cache, "c")).toBe("3");
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 1 });
  });

  it("never holds more than the byte bound, counting multi-byte text and keys", async () => {
    const cache = local({ maxBytes: 40 });
    for (let index = 0; index < 50; index++) {
      await put(cache, "k" + index, "é".repeat(5));
      expect(cache.stats().bytes).toBeLessThanOrEqual(40);
    }
    expect(cache.stats().entries).toBe(3);
    // Replacing a key does not double count it.
    await put(cache, "k49", "x");
    expect(cache.stats().bytes).toBe(13 + 13 + 4);
  });

  it("does not cache a value larger than the whole budget, and keeps the rest", async () => {
    const cache = local({ maxBytes: 20 });
    await put(cache, "a", "small");
    await put(cache, "big", "x".repeat(100));
    expect(await value(cache, "big")).toBeUndefined();
    expect(await value(cache, "a")).toBe("small");
  });

  it("drops a write whose load began before an invalidation", async () => {
    const cache = local();
    const before = await cache.read("a");
    await cache.invalidateAll();
    await cache.write("a", "stale", before.generation);
    expect(await value(cache, "a")).toBeUndefined();
    await put(cache, "a", "fresh");
    expect(await value(cache, "a")).toBe("fresh");
  });
});

describe("ReadThroughCache", () => {
  const through = (backend = local(), maxConcurrentLoads = 2, maxQueuedLoads = 10) =>
    new ReadThroughCache({ backend, maxConcurrentLoads, maxQueuedLoads });

  it("loads once per key for concurrent callers and hands each its own copy", async () => {
    const cache = through();
    const gate = deferred<{ items: number[] }>();
    let loads = 0;
    const load = () => (loads++, gate.promise);
    const pending = [cache.getOrLoad("list", load), cache.getOrLoad("list", load)];
    await Promise.resolve();
    gate.resolve({ items: [1] });
    const [first, second] = await Promise.all(pending);
    expect(loads).toBe(1);
    expect(first).toEqual({ items: [1] });
    expect(first).not.toBe(second);
    first!.items.push(2);
    expect(await cache.getOrLoad("list", load)).toEqual({ items: [1] });
    expect(loads).toBe(1);
  });

  it("does not cache failures", async () => {
    const cache = through();
    await expect(cache.getOrLoad("u", () => Promise.resolve(undefined))).rejects.toThrow(TypeError);
    await expect(cache.getOrLoad("a", () => Promise.reject(new Error("db")))).rejects.toThrow();
    expect(await cache.getOrLoad("a", () => Promise.resolve(1))).toBe(1);
  });

  it("never serves or stores data loaded before an invalidation", async () => {
    const cache = through();
    const slow = deferred<string>();
    const early = cache.getOrLoad("product", () => slow.promise);
    await Promise.resolve();
    // The mutation commits and invalidates while the old read is still in flight.
    await cache.invalidateAll();
    const late = cache.getOrLoad("product", () => Promise.resolve("after"));
    slow.resolve("before");
    expect(await early).toBe("before");
    expect(await late).toBe("after");
    expect(await cache.getOrLoad("product", () => Promise.resolve("reloaded"))).toBe("after");
  });

  it("bounds concurrent misses and refuses new ones when the queue is full", async () => {
    const cache = through(local(), 2, 1);
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let running = 0;
    let peak = 0;
    const load = (index: number) => async () => {
      peak = Math.max(peak, ++running);
      const result = await gates[index]!.promise;
      running--;
      return result;
    };
    const pending = [0, 1, 2].map((index) => cache.getOrLoad("k" + index, load(index)));
    await new Promise((done) => setImmediate(done));
    await expect(cache.getOrLoad("k3", () => Promise.resolve(3))).rejects.toBeInstanceOf(
      CacheOverloadedError,
    );
    gates.forEach((gate, index) => gate.resolve(index));
    expect(await Promise.all(pending)).toEqual([0, 1, 2]);
    expect(peak).toBe(2);
    // Slots are released: later misses run again.
    expect(await cache.getOrLoad("k3", () => Promise.resolve(3))).toBe(3);
  });
});

describe("SharedCache (replicated profile)", () => {
  function redis() {
    const data = new Map<string, string>();
    const state = { down: false, ttls: [] as number[] };
    const client: RedisCacheClient = {
      get: async (key) => {
        if (state.down) throw new Error("ECONNREFUSED");
        return data.get(key) ?? null;
      },
      set: async (key: string, stored: string, _mode?: "PX", ttlMs?: number) => {
        if (state.down) throw new Error("ECONNREFUSED");
        if (ttlMs !== undefined) state.ttls.push(ttlMs);
        data.set(key, stored);
      },
    };
    return { client, data, state };
  }
  let generations = 0;
  const replica = (store: ReturnType<typeof redis>, failures: unknown[] = []) =>
    new ReadThroughCache({
      backend: new SharedCache({
        redis: store.client,
        fallback: local(),
        ttlMs: 30_000,
        namespace: "ih:cat:v1",
        maxValueBytes: 1_000,
        newGeneration: () => "g" + ++generations,
        onUnavailable: (error) => failures.push(error),
      }),
      maxConcurrentLoads: 4,
      maxQueuedLoads: 4,
    });

  it("shares entries between replicas, with a TTL, and invalidates all of them at once", async () => {
    const store = redis();
    const [one, two] = [replica(store), replica(store)];
    expect(await one.getOrLoad("p", () => Promise.resolve("v1"))).toBe("v1");
    expect(await two.getOrLoad("p", () => Promise.resolve("never"))).toBe("v1");
    expect(store.state.ttls).toEqual([30_000]);
    await one.invalidateAll();
    expect(await two.getOrLoad("p", () => Promise.resolve("v2"))).toBe("v2");
    expect(await one.getOrLoad("p", () => Promise.resolve("never"))).toBe("v2");
  });

  it("does not join another replica's pre-invalidation load", async () => {
    const store = redis();
    const [one, two] = [replica(store), replica(store)];
    const slow = deferred<string>();
    const early = two.getOrLoad("p", () => slow.promise);
    await new Promise((done) => setImmediate(done));
    await one.invalidateAll();
    const late = two.getOrLoad("p", () => Promise.resolve("after"));
    slow.resolve("before");
    expect(await early).toBe("before");
    expect(await late).toBe("after");
    expect(await one.getOrLoad("p", () => Promise.resolve("never"))).toBe("after");
  });

  it("does not store oversized values in the shared store", async () => {
    const store = redis();
    const cache = replica(store);
    await cache.getOrLoad("big", () => Promise.resolve("x".repeat(2_000)));
    expect([...store.data.keys()]).toEqual([]);
  });

  it("falls back to bounded local reads during an outage and reports it", async () => {
    const store = redis();
    const failures: unknown[] = [];
    const cache = replica(store, failures);
    store.state.down = true;
    let loads = 0;
    const load = () => Promise.resolve("local-" + ++loads);
    expect(await cache.getOrLoad("p", load)).toBe("local-1");
    expect(await cache.getOrLoad("p", load)).toBe("local-1");
    expect(failures.length).toBeGreaterThan(0);
    // Invalidation still clears this replica, and rejects so the caller retries the shared store.
    await expect(cache.invalidateAll()).rejects.toThrow();
    expect(await cache.getOrLoad("p", load)).toBe("local-2");
    store.state.down = false;
    await cache.invalidateAll();
    expect(await cache.getOrLoad("p", load)).toBe("local-3");
    expect(store.data.size).toBe(2);
  });
});
