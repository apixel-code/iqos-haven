import { createHmac } from "node:crypto";

/**
 * Endpoint-specific rate limiting (architecture §11 "Rate-limit and dependency outage policy").
 *
 * Fixed-window counters, identical locally and in the shared cache Redis. The budget profile uses
 * the bounded local limiter as the authority; the replicated profile uses the shared limiter and,
 * per endpoint, either fails closed (authentication) or falls back to bounded local per-instance
 * ceilings (checkout/quote). Limiter keys are purpose-specific keyed hashes: raw IPs, emails or
 * phones never become keys or log fields.
 */
export interface LimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface LimitDecision {
  readonly allowed: boolean;
  /** 0 when allowed. */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, rule: LimitRule): Promise<LimitDecision>;
  reset(key: string): Promise<void>;
}

export interface LocalRateLimiterOptions {
  /**
   * Cap on tracked keys per partition (`endpoint:dimension`, the key's first two segments), so
   * flooding one dimension (random emails) cannot crowd out another (client IPs).
   */
  readonly maxKeys: number;
  readonly now?: () => number;
}

type Window = { count: number; resetAt: number };

/**
 * Per-process limiter with per-partition entry caps and throttled expiry cleanup. When a
 * partition is full of live windows, new keys share one overflow window per partition with the
 * same rule: a conservative ceiling (architecture §11), never eviction into unlimited admission
 * and never a blanket denial of every new caller.
 */
export class LocalRateLimiter implements RateLimiter {
  private readonly partitions = new Map<string, Map<string, Window>>();
  private readonly overflow = new Map<string, Window>();
  private readonly now: () => number;
  private nextSweep = 0;

  constructor(private readonly options: LocalRateLimiterOptions) {
    if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1)
      throw new Error("maxKeys must be a positive integer");
    this.now = options.now ?? Date.now;
  }

  /** Tracked keys across partitions (overflow windows excluded). */
  get size(): number {
    let size = 0;
    for (const windows of this.partitions.values()) size += windows.size;
    return size;
  }

  consume(key: string, rule: LimitRule): Promise<LimitDecision> {
    return Promise.resolve(this.consumeSync(key, rule));
  }

  reset(key: string): Promise<void> {
    this.partitions.get(partitionOf(key))?.delete(key);
    return Promise.resolve();
  }

  private consumeSync(key: string, rule: LimitRule): LimitDecision {
    const now = this.now();
    // Cleanup is O(tracked keys) at most once a second, never per request at the cap.
    if (now >= this.nextSweep) this.sweep(now);
    const partition = partitionOf(key);
    let windows = this.partitions.get(partition);
    if (!windows) this.partitions.set(partition, (windows = new Map()));
    let window = windows.get(key);
    if (window && window.resetAt <= now) {
      windows.delete(key);
      window = undefined;
    }
    if (!window) {
      if (windows.size < this.options.maxKeys) {
        window = { count: 0, resetAt: now + rule.windowMs };
        windows.set(key, window);
      } else {
        window = this.overflow.get(partition);
        if (!window || window.resetAt <= now) {
          window = { count: 0, resetAt: now + rule.windowMs };
          this.overflow.set(partition, window);
        }
      }
    }
    window.count += 1;
    return window.count <= rule.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: window.resetAt - now };
  }

  private sweep(now: number): void {
    this.nextSweep = now + 1000;
    for (const [partition, windows] of this.partitions) {
      for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
      if (!windows.size) this.partitions.delete(partition);
    }
    for (const [partition, window] of this.overflow)
      if (window.resetAt <= now) this.overflow.delete(partition);
  }
}

function partitionOf(key: string): string {
  const first = key.indexOf(":");
  const second = first < 0 ? -1 : key.indexOf(":", first + 1);
  return second < 0 ? key : key.slice(0, second);
}

/** Minimal Redis surface (ioredis-compatible) so this package does not own a client. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<number>;
}

const FIXED_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}`;

/** Shared limiter for the replicated profile (cache Redis). Errors propagate to the policy. */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisEval,
    private readonly prefix = "ih:rl:",
  ) {}

  async consume(key: string, rule: LimitRule): Promise<LimitDecision> {
    const result = await this.redis.eval(FIXED_WINDOW, 1, this.prefix + key, rule.windowMs);
    if (!Array.isArray(result) || result.length !== 2) throw new Error("unexpected limiter reply");
    const [count, ttl] = result.map(Number) as [number, number];
    return count <= rule.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: Math.max(1, ttl) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

/**
 * One endpoint's limits. `rules` are checked against the primary limiter, dimension by dimension.
 * `outage` decides what happens when the primary (shared) limiter fails:
 * - "fail_closed": the request is rejected (authentication endpoints).
 * - fallback: bounded local per-instance rules plus a per-process ceiling (checkout/quote).
 */
export interface EndpointLimitPolicy<D extends string = string> {
  readonly endpoint: string;
  readonly rules: Readonly<Record<D, LimitRule>>;
  readonly outage:
    | "fail_closed"
    | {
        readonly fallback: Readonly<Record<D, LimitRule>>;
        readonly processCeiling: LimitRule;
      };
}

export interface EndpointDecision extends LimitDecision {
  /** True when the decision came from the local outage fallback. */
  readonly degraded: boolean;
  /** Dimension that denied the request (for logs; never the key value). */
  readonly deniedBy?: string;
}

/** The primary limiter is unavailable and the endpoint fails closed. */
export class RateLimiterUnavailableError extends Error {
  constructor(readonly endpoint: string) {
    super(`rate limiter unavailable for ${endpoint}`);
    this.name = "RateLimiterUnavailableError";
  }
}

export interface EndpointLimiterOptions {
  /** Shared limiter (replicated) or the local one itself (budget). */
  readonly primary: RateLimiter;
  /** Local limiter used for outage fallbacks. */
  readonly local: RateLimiter;
  /** Keyed-hash secret (>= 32 bytes); identical on every replica sharing the primary. */
  readonly keySecret: string | Buffer;
  /** Called when the primary failed (metric/alert hook). Receives no key material. */
  readonly onPrimaryFailure?: (endpoint: string, error: unknown) => void;
}

export class EndpointLimiter {
  constructor(private readonly options: EndpointLimiterOptions) {
    if (Buffer.byteLength(options.keySecret) < 32)
      throw new Error("rate-limit key secret must be at least 32 bytes");
  }

  /** Purpose-specific keyed hash: the same value hashes differently per endpoint and dimension. */
  key(endpoint: string, dimension: string, value: string): string {
    const digest = createHmac("sha256", this.options.keySecret)
      .update(`${endpoint}\0${dimension}\0${value}`)
      .digest("base64url");
    return `${endpoint}:${dimension}:${digest}`;
  }

  async consume<D extends string>(
    policy: EndpointLimitPolicy<D>,
    values: Readonly<Record<D, string>>,
  ): Promise<EndpointDecision> {
    const dimensions = Object.keys(policy.rules) as D[];
    try {
      return await this.check(
        this.options.primary,
        policy.endpoint,
        policy.rules,
        values,
        dimensions,
        false,
      );
    } catch (error) {
      this.options.onPrimaryFailure?.(policy.endpoint, error);
      if (policy.outage === "fail_closed") throw new RateLimiterUnavailableError(policy.endpoint);
      const ceiling = await this.options.local.consume(
        `${policy.endpoint}:process`,
        policy.outage.processCeiling,
      );
      if (!ceiling.allowed) return { ...ceiling, degraded: true, deniedBy: "process" };
      return this.check(
        this.options.local,
        policy.endpoint,
        policy.outage.fallback,
        values,
        dimensions,
        true,
      );
    }
  }

  /** Clears a dimension's window (e.g. the identity window after a successful sign-in). */
  async reset<D extends string>(
    policy: EndpointLimitPolicy<D>,
    dimension: D,
    value: string,
  ): Promise<void> {
    const key = this.key(policy.endpoint, dimension, value);
    const [primary] = await Promise.allSettled([
      this.options.primary.reset(key),
      this.options.local.reset(key),
    ]);
    if (primary.status === "rejected")
      this.options.onPrimaryFailure?.(policy.endpoint, primary.reason);
  }

  private async check<D extends string>(
    limiter: RateLimiter,
    endpoint: string,
    rules: Readonly<Record<D, LimitRule>>,
    values: Readonly<Record<D, string>>,
    dimensions: readonly D[],
    degraded: boolean,
  ): Promise<EndpointDecision> {
    // Dimensions are checked in policy order and stop at the first denial: put the cheapest,
    // broadest key (client IP) first so a denied source cannot create further keys. The attempt
    // has still been counted against every dimension checked so far.
    let denied: EndpointDecision | undefined;
    for (const dimension of dimensions) {
      const decision = await limiter.consume(
        this.key(endpoint, dimension, values[dimension]),
        rules[dimension],
      );
      if (!decision.allowed) {
        denied = { ...decision, degraded, deniedBy: dimension };
        break;
      }
    }
    return denied ?? { allowed: true, retryAfterMs: 0, degraded };
  }
}
