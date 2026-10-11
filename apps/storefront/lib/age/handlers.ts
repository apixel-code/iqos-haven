import { isIP } from "node:net";
import {
  signAgeTicket,
  verifyAgeTicket,
  readAgeCookie,
  type AgeTicketKeyRing,
  type AgeTicketResult,
  type AgeTicketSigner,
} from "@ih/platform/age-ticket";
import type { EndpointLimiter, EndpointLimitPolicy } from "@ih/platform/rate-limit";
import {
  RESTRICTED_PATH,
  ageCookie,
  clearedAgeCookie,
  clearedRestrictedCookie,
  isSameOriginPost,
  restrictedCookie,
  safeReturnPath,
} from "./policy";

/** Everything the gate needs at run time; built once per process from validated configuration. */
export interface AgeRuntime {
  readonly keys: AgeTicketKeyRing;
  /** Undefined when no signing key is configured: acceptance is then unavailable (fail closed). */
  readonly signer: AgeTicketSigner | undefined;
  readonly policyVersion: string;
  readonly ticketTtlSeconds: number;
  readonly restrictedSeconds: number;
  readonly origins: readonly string[];
  readonly limiter: EndpointLimiter;
}

/** Per client address; the gateway sets the address header and strips browser-supplied ones. */
export const AGE_DECISION_POLICY: EndpointLimitPolicy<"ip"> = {
  endpoint: "age.decision",
  rules: { ip: { limit: 20, windowMs: 60_000 } },
  outage: "fail_closed",
};

export function verifyRequestTicket(runtime: AgeRuntime, cookieHeader: string | null) {
  return verifyAgeTicket(readAgeCookie(cookieHeader ?? undefined), {
    keys: runtime.keys,
    audience: "storefront",
    policyVersion: runtime.policyVersion,
  }) satisfies AgeTicketResult;
}

const NO_STORE = { "Cache-Control": "private, no-store" };
const refuse = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, {
    status,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });

/** 303 so the browser follows with GET; a relative Location stays on the origin it was sent to. */
function seeOther(location: string, cookies: string[]): Response {
  const headers = new Headers({ ...NO_STORE, Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function guard(runtime: AgeRuntime, request: Request): Promise<Response | null> {
  if (!isSameOriginPost(request.headers, runtime.origins)) return refuse(403, "Request refused.");
  const header = request.headers.get("x-ih-client-ip");
  const ip = header && isIP(header) ? header : "unknown";
  const decision = await runtime.limiter.consume(AGE_DECISION_POLICY, { ip });
  if (!decision.allowed)
    return refuse(429, "Too many attempts. Please try again shortly.", {
      "Retry-After": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
    });
  return null;
}

/** Form field `return` (a local path), bounded; anything unusable becomes "/". */
async function returnPath(request: Request): Promise<string> {
  try {
    const value = (await request.formData()).get("return");
    return safeReturnPath(typeof value === "string" ? value : null);
  } catch {
    return "/";
  }
}

/**
 * The two decision handlers (architecture §9). Acceptance is the only place a ticket is minted.
 * Neither handler reads or trusts anything but the request's Origin, its client address for
 * limiting and the `return` form field.
 */
export function createAgeHandlers(runtime: AgeRuntime) {
  return {
    async accept(request: Request): Promise<Response> {
      const refused = await guard(runtime, request);
      if (refused) return refused;
      if (!runtime.signer) return refuse(503, "The age check is unavailable right now.");
      const { ticket } = signAgeTicket(runtime.signer, {
        policyVersion: runtime.policyVersion,
        ttlSeconds: runtime.ticketTtlSeconds,
      });
      return seeOther(await returnPath(request), [
        ageCookie(ticket, runtime.ticketTtlSeconds),
        clearedRestrictedCookie(),
      ]);
    },
    async reject(request: Request): Promise<Response> {
      const refused = await guard(runtime, request);
      if (refused) return refused;
      return seeOther(RESTRICTED_PATH, [
        clearedAgeCookie(),
        restrictedCookie(runtime.restrictedSeconds),
      ]);
    },
  };
}
