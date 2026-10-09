import type { ApiEnv } from "@ih/config";
import type { EndpointLimitPolicy, LimitRule } from "@ih/platform";

/**
 * Endpoint limit policies (architecture §11). Values are conservative starting points, not
 * measured capacity: verify in staging before release (M11). Authentication endpoints fail closed
 * when their authoritative limiter is unavailable; checkout/quote fall back to bounded local
 * per-instance budgets (cluster budget ÷ RATE_LIMIT_MAX_REPLICAS) plus a per-process ceiling.
 */
const MINUTE = 60_000;
const perMinute = (limit: number): LimitRule => ({ limit, windowMs: MINUTE });
const perInstance = (env: ApiEnv, limit: number): LimitRule =>
  perMinute(Math.max(1, Math.floor(limit / env.RATE_LIMIT_MAX_REPLICAS)));

/**
 * Sign-in: per client IP, per identity from one network, and per identity overall. Windows are
 * temporary, so an attacker can delay but never permanently lock out an account; a successful
 * sign-in clears the identity windows. Attempts count before the password is verified.
 */
export const LOGIN_POLICY: EndpointLimitPolicy<"ip" | "identityNetwork" | "identity"> = {
  endpoint: "login",
  rules: {
    ip: { limit: 30, windowMs: 15 * MINUTE },
    identityNetwork: { limit: 10, windowMs: 15 * MINUTE },
    identity: { limit: 50, windowMs: 60 * MINUTE },
  },
  outage: "fail_closed",
};

/** Order submission (used from step 75): attempted submissions count, not just orders. */
export const checkoutPolicy = (env: ApiEnv): EndpointLimitPolicy<"ip" | "phone"> => ({
  endpoint: "checkout",
  rules: { ip: perMinute(10), phone: perMinute(5) },
  outage: {
    fallback: { ip: perInstance(env, 5), phone: perInstance(env, 2) },
    processCeiling: perMinute(60),
  },
});

/** Cart repricing is budgeted separately so it never consumes the order-submission allowance. */
export const quotePolicy = (env: ApiEnv): EndpointLimitPolicy<"ip"> => ({
  endpoint: "quote",
  rules: { ip: perMinute(60) },
  outage: { fallback: { ip: perInstance(env, 30) }, processCeiling: perMinute(600) },
});
