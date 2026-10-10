import { PermanentEffectError, type ExternalEffectHandler } from "@ih/application";
import { EVENT_CATALOGUE, type InternalRevalidateRequest } from "@ih/contracts";
import type { Logger } from "@ih/logger";
import { signServiceRequest, type ServiceKey } from "@ih/platform";

const REVALIDATE_PATH = "/v1/internal/revalidate";
const REQUEST_TIMEOUT_MS = 5_000;

/** Carries a stable code into `last_error`; the effect row owns the retry schedule. */
class RevalidateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RevalidateTarget {
  /** Private API base URL (never the public gateway). */
  readonly apiUrl: string;
  readonly key: ServiceKey;
}

/**
 * Durable cache-owner invalidation (roadmap step 52, ADR 0022). The API already dropped its
 * local entries after commit; this effect repeats the call with HMAC service auth so a crash,
 * a restart race or a shared-store outage is retried. The call is idempotent, so redelivery is
 * harmless. Any non-2xx answer is retried: bad keys or clock skew are fixed by an operator, and
 * the attempt budget then leaves a dead effect to alert on.
 *
 * Without a target (local development only; deployed environments require it) the effect is
 * completed as skipped and the cache TTL bounds staleness.
 */
export function createRevalidateConsumer(options: {
  target: RevalidateTarget | undefined;
  log: Logger;
  fetch?: typeof fetch;
}): ExternalEffectHandler {
  const { target, log } = options;
  const send = options.fetch ?? fetch;
  return {
    kind: "external",
    consumer: "storefront_revalidate",
    async perform(context, signal) {
      const payload = EVENT_CATALOGUE["catalog.changed"].payload.safeParse(context.payload);
      if (context.eventType !== "catalog.changed" || !payload.success)
        throw new PermanentEffectError("INVALID_REVALIDATE_EVENT");
      if (!target) return { receipt: "skipped:not_configured" };
      const body = JSON.stringify({
        scope: "catalogue",
        eventId: context.eventId,
      } satisfies InternalRevalidateRequest);
      let response;
      try {
        response = await send(new URL(REVALIDATE_PATH, target.apiUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signServiceRequest(target.key, { method: "POST", path: REVALIDATE_PATH, body }),
          },
          body,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        throw new RevalidateError("REVALIDATE_UNREACHABLE");
      }
      // Drain so the connection is reusable; the body is never needed.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new RevalidateError(`REVALIDATE_HTTP_${response.status}`);
      log.info({ effectId: context.effectId, eventId: context.eventId }, "catalogue revalidated");
      return { receipt: `invalidated:${response.status}` };
    },
  };
}

/** Builds the target from worker configuration, or undefined when it is not configured. */
export function revalidateTargetFromEnv(env: {
  API_INTERNAL_URL?: string | undefined;
  INTERNAL_SERVICE_ID?: string | undefined;
  INTERNAL_SERVICE_KEY_ID?: string | undefined;
  INTERNAL_SERVICE_KEY?: string | undefined;
}): RevalidateTarget | undefined {
  if (
    !env.API_INTERNAL_URL ||
    !env.INTERNAL_SERVICE_ID ||
    !env.INTERNAL_SERVICE_KEY_ID ||
    !env.INTERNAL_SERVICE_KEY
  )
    return undefined;
  return {
    apiUrl: env.API_INTERNAL_URL,
    key: {
      service: env.INTERNAL_SERVICE_ID,
      keyId: env.INTERNAL_SERVICE_KEY_ID,
      secret: env.INTERNAL_SERVICE_KEY,
    },
  };
}
