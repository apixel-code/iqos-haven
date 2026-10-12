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

/** Reset requests count identically for known and unknown identities; never cleared by request. */
export const RESET_REQUEST_POLICY: EndpointLimitPolicy<"ip" | "identity"> = {
  endpoint: "password_reset_request",
  rules: {
    ip: { limit: 20, windowMs: 15 * MINUTE },
    identity: { limit: 3, windowMs: 30 * MINUTE },
  },
  outage: "fail_closed",
};
/** IP-only: rotating invalid tokens must not create an unbounded second limiter partition. */
export const RESET_CONSUME_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "password_reset_consume",
  rules: { ip: { limit: 20, windowMs: 15 * MINUTE } },
  outage: "fail_closed",
};

export const INVITATION_MANAGE_POLICY: EndpointLimitPolicy<"ip" | "actor"> = {
  endpoint: "invitation_manage",
  rules: { ip: { limit: 30, windowMs: 60 * MINUTE }, actor: { limit: 30, windowMs: 60 * MINUTE } },
  outage: "fail_closed",
};
export const INVITATION_ACCEPT_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "invitation_accept",
  rules: { ip: { limit: 20, windowMs: 15 * MINUTE } },
  outage: "fail_closed",
};

export const STAFF_MANAGE_POLICY: EndpointLimitPolicy<"ip" | "actor"> = {
  endpoint: "staff_manage",
  rules: { ip: { limit: 30, windowMs: 60 * MINUTE }, actor: { limit: 30, windowMs: 60 * MINUTE } },
  outage: "fail_closed",
};

export const SETTINGS_MANAGE_POLICY = {
  ...STAFF_MANAGE_POLICY,
  endpoint: "settings.manage",
} as const;

export const DELIVERY_MANAGE_POLICY = {
  ...STAFF_MANAGE_POLICY,
  endpoint: "delivery.manage",
} as const;
export const COUPONS_MANAGE_POLICY = {
  ...STAFF_MANAGE_POLICY,
  endpoint: "coupons.manage",
} as const;

/** Catalogue edits are routine Staff work (about 50 products), so budgets are wider than config. */
export const CATALOG_MANAGE_POLICY: EndpointLimitPolicy<"ip" | "actor"> = {
  endpoint: "catalog_manage",
  rules: {
    ip: { limit: 600, windowMs: 60 * MINUTE },
    actor: { limit: 300, windowMs: 60 * MINUTE },
  },
  outage: "fail_closed",
};

export const INVENTORY_ADJUST_POLICY = {
  ...CATALOG_MANAGE_POLICY,
  endpoint: "inventory_adjust",
} as const;

/**
 * Shopper catalogue reads (step 58), per client address. Browsing must keep working when the
 * shared limiter is down, so the outage path is a bounded local budget plus a process ceiling.
 * Reads are cached, so these budgets protect against scraping more than against database load.
 */
export const STORE_CATALOG_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "store_catalog",
  rules: { ip: perMinute(240) },
  outage: { fallback: { ip: perMinute(120) }, processCeiling: perMinute(6000) },
};

/**
 * Search and facets (step 60) are not cached, because the text is free-form, so their budget is
 * tighter than cached catalogue reads. Suggestions fire while typing and are cheaper.
 */
export const STORE_SEARCH_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "store_search",
  rules: { ip: perMinute(60) },
  outage: { fallback: { ip: perMinute(30) }, processCeiling: perMinute(1500) },
};
export const STORE_SUGGEST_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "store_suggest",
  rules: { ip: perMinute(120) },
  outage: { fallback: { ip: perMinute(60) }, processCeiling: perMinute(3000) },
};

/** Device-cart refresh (step 62): one uncached indexed read per cart view or change. */
export const STORE_CART_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "store_cart",
  rules: { ip: perMinute(120) },
  outage: { fallback: { ip: perMinute(60) }, processCeiling: perMinute(3000) },
};

/** Saved-items and recently-viewed cards (step 63): uncached reads keyed by the device's list. */
export const STORE_CARDS_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "store_cards",
  rules: { ip: perMinute(120) },
  outage: { fallback: { ip: perMinute(60) }, processCeiling: perMinute(3000) },
};
