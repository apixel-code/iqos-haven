import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { createLogger, errorSummary } from "@ih/logger";
import {
  EndpointLimiter,
  LocalRateLimiter,
  RateLimiterUnavailableError,
  RedisRateLimiter,
  type EndpointLimitPolicy,
  type RateLimiter,
} from "@ih/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { API_ENV, CACHE_REDIS } from "../infra/tokens";

const SHARED_TIMEOUT_MS = 500;

/**
 * Applies endpoint limit policies. Budget profile: the bounded local limiter is authoritative.
 * Replicated profile: the shared cache-Redis limiter is primary, with the per-endpoint outage
 * behaviour from the policy. Denials answer the generic 429 envelope with Retry-After; an
 * unavailable authoritative limiter on a fail-closed endpoint answers 503.
 */
@Injectable()
export class RateLimitService {
  private readonly limiter: EndpointLimiter;
  private readonly log;

  constructor(@Inject(API_ENV) env: ApiEnv, @Inject(CACHE_REDIS) cache: Redis | null) {
    this.log = createLogger({ service: "api-rate-limit", level: env.LOG_LEVEL });
    const local = new LocalRateLimiter({ maxKeys: env.RATE_LIMIT_LOCAL_MAX_KEYS });
    let primary: RateLimiter = local;
    if (env.RATE_LIMIT_PROFILE === "replicated") {
      if (!cache) throw new Error("replicated rate limiting needs CACHE_REDIS_URL");
      primary = new RedisRateLimiter({
        eval: async (script, numKeys, ...args) => {
          if (cache.status === "wait" || cache.status === "end") await cache.connect();
          return withTimeout(cache.eval(script, numKeys, ...args));
        },
        del: (key) => withTimeout(cache.del(key)),
      });
    }
    this.limiter = new EndpointLimiter({
      primary,
      local,
      // Local-only keys may use a per-process secret; shared keys need the configured one.
      keySecret: env.RATE_LIMIT_KEY_SECRET ?? randomBytes(32),
      onPrimaryFailure: (endpoint, error) =>
        // Outage signal for alerting; endpoint name only, never key material.
        this.log.warn(
          { endpoint, degraded: true, ...errorSummary(error) },
          "shared rate limiter unavailable",
        ),
    });
  }

  async enforce<D extends string>(
    policy: EndpointLimitPolicy<D>,
    values: Readonly<Record<D, string>>,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let decision;
    try {
      decision = await this.limiter.consume(policy, values);
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        reply.header("Retry-After", "30");
        throw new ServiceUnavailableException();
      }
      throw error;
    }
    if (decision.degraded) request.log.warn({ endpoint: policy.endpoint }, "rate limit degraded");
    if (decision.allowed) return;
    // Identity-wide denials can be an attacker delaying a real account: warn so it can alert.
    const context = {
      endpoint: policy.endpoint,
      dimension: decision.deniedBy,
      degraded: decision.degraded,
    };
    if (decision.deniedBy === "identity") request.log.warn(context, "rate limited");
    else request.log.info(context, "rate limited");
    reply.header("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Best effort: a failed reset only means the window expires on its own. */
  async reset<D extends string>(
    policy: EndpointLimitPolicy<D>,
    dimension: D,
    value: string,
  ): Promise<void> {
    await this.limiter.reset(policy, dimension, value);
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rate limiter timeout")), SHARED_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
