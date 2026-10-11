import { randomBytes } from "node:crypto";
import { ageTicketKeyRing, ageTicketSigner } from "@ih/platform/age-ticket";
import { EndpointLimiter, LocalRateLimiter } from "@ih/platform/rate-limit";
import { storefrontEnv } from "../env";
import { createAgeHandlers, type AgeRuntime } from "./handlers";

let cached: { runtime: AgeRuntime; handlers: ReturnType<typeof createAgeHandlers> } | undefined;

/**
 * Process-wide gate runtime from validated configuration. This module is the only place in the
 * storefront that reads the signing key. It imports node:crypto and the server configuration, so
 * it cannot be bundled for the browser; import it only from route handlers, `proxy.ts` and
 * server components.
 */
export function ageGate() {
  if (cached) return cached;
  const env = storefrontEnv();
  const local = new LocalRateLimiter({ maxKeys: 50_000 });
  const runtime: AgeRuntime = {
    keys: ageTicketKeyRing(env.AGE_TICKET_PUBLIC_KEYS),
    signer:
      env.AGE_TICKET_KEY_ID && env.AGE_TICKET_PRIVATE_KEY
        ? ageTicketSigner(env.AGE_TICKET_KEY_ID, env.AGE_TICKET_PRIVATE_KEY)
        : undefined,
    policyVersion: env.AGE_POLICY_VERSION,
    ticketTtlSeconds: env.AGE_TICKET_TTL_DAYS * 24 * 60 * 60,
    restrictedSeconds: env.AGE_RESTRICTED_MINUTES * 60,
    origins: env.STOREFRONT_ORIGINS,
    // One storefront process owns its limiter; keys never leave it, so a per-process secret is enough.
    limiter: new EndpointLimiter({ primary: local, local, keySecret: randomBytes(32) }),
  };
  cached = { runtime, handlers: createAgeHandlers(runtime) };
  return cached;
}
