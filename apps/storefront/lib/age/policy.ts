import { AGE_COOKIE, type AgeTicketResult } from "@ih/platform/age-ticket";

/**
 * Pure age-gate rules for the storefront (roadmap step 56, architecture §9, ADR 0025). No I/O:
 * the routing gate (`proxy.ts`) and the decision handlers call these with what they read.
 */
export const RESTRICTED_COOKIE = "ih_age_restricted";
export const AGE_CHECK_PATH = "/age-check";
export const RESTRICTED_PATH = "/restricted";
/**
 * Where a shopper goes when the API refuses a ticket this storefront accepted (keys or policy
 * out of step, or a ticket that expired between the two checks). `recheck` makes the gate show
 * the age question instead of bouncing the still-"valid" ticket straight back, which would loop.
 */
export const AGE_RECHECK_PATH = `${AGE_CHECK_PATH}?recheck=1`;
/** Exact paths: a future route under /api/age/ is gated unless it is added here. */
const DECISION_PATHS: readonly string[] = ["/api/age/accept", "/api/age/reject"];
/**
 * Public pages without catalogue data: policy pages, the crawler policy and the one generic
 * preview image. Kept in step with `POLICY_PAGES` in `lib/site.ts` by a unit test.
 */
const PUBLIC_INFO_PATHS: readonly string[] = [
  "/responsible-use",
  "/terms",
  "/privacy",
  "/robots.txt",
  "/opengraph-image",
];
const MAX_RETURN_LENGTH = 512;
const BASE = "http://storefront.invalid";

/**
 * Paths reachable without an accepted age ticket. Everything else is restricted by default, so
 * a new page is gated unless it is added here deliberately.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === AGE_CHECK_PATH ||
    pathname === RESTRICTED_PATH ||
    pathname === "/health" ||
    DECISION_PATHS.includes(pathname) ||
    PUBLIC_INFO_PATHS.includes(pathname)
  );
}

/**
 * A return target the shopper may be sent to after accepting: a local path on this origin, or
 * "/". Absolute and scheme-relative URLs, backslashes, control characters, encoded slashes at
 * the start, the gate's own pages and API routes all fall back to "/".
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || raw.length > MAX_RETURN_LENGTH) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  // The parser must agree that this stays on our origin and did not normalise into "//host".
  if (url.origin !== BASE || url.pathname.startsWith("//")) return "/";
  // Never return to the gate itself, an API route or a framework asset.
  if (
    isPublicPath(url.pathname) ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/")
  )
    return "/";
  return url.pathname + url.search;
}

export type GateAction =
  { readonly kind: "allow" } | { readonly kind: "redirect"; readonly location: string };

/**
 * Routing decision for one request. Order: a valid ticket wins; otherwise a recent rejection
 * shows the restricted page; otherwise the age check, remembering where the shopper was going.
 */
export function gateAction(input: {
  pathname: string;
  search: string;
  ticket: AgeTicketResult;
  restricted: boolean;
}): GateAction {
  const { pathname, search, ticket, restricted } = input;
  if (ticket.ok) {
    // An accepted shopper has no reason to see the gate pages again.
    if (pathname === AGE_CHECK_PATH) {
      const params = new URLSearchParams(search);
      // Asked to confirm again: show the question; accepting issues a fresh ticket.
      if (params.get("recheck") === "1") return { kind: "allow" };
      return { kind: "redirect", location: safeReturnPath(params.get("return")) };
    }
    if (pathname === RESTRICTED_PATH) return { kind: "redirect", location: "/" };
    return { kind: "allow" };
  }
  if (restricted) {
    // A rejected visitor may still read the policies, but never reaches the age question.
    if (pathname !== AGE_CHECK_PATH && isPublicPath(pathname)) return { kind: "allow" };
    return { kind: "redirect", location: RESTRICTED_PATH };
  }
  if (isPublicPath(pathname)) return { kind: "allow" };
  const target = safeReturnPath(pathname + search);
  return {
    kind: "redirect",
    location:
      target === "/" ? AGE_CHECK_PATH : `${AGE_CHECK_PATH}?return=${encodeURIComponent(target)}`,
  };
}

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";
/** The signed ticket. HttpOnly: no script can read or replace it. */
export const ageCookie = (ticket: string, maxAgeSeconds: number) =>
  `${AGE_COOKIE}=${ticket}; Max-Age=${maxAgeSeconds}; ${ATTRIBUTES}`;
export const clearedAgeCookie = () => `${AGE_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
/** Marks a recent rejection. It grants nothing, so it needs no signature. */
export const restrictedCookie = (maxAgeSeconds: number) =>
  `${RESTRICTED_COOKIE}=1; Max-Age=${maxAgeSeconds}; ${ATTRIBUTES}`;
export const clearedRestrictedCookie = () => `${RESTRICTED_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

export function hasRestrictedCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const index = part.indexOf("=");
    return (
      index > 0 &&
      part.slice(0, index).trim() === RESTRICTED_COOKIE &&
      part.slice(index + 1).trim() === "1"
    );
  });
}

/**
 * Origin validation for the decision POSTs: the Origin header must be one of our storefront
 * origins, and a browser that reports the request as cross-site is refused. A request without an
 * Origin header is refused: every browser sends it on a form POST.
 */
export function isSameOriginPost(
  headers: { get(name: string): string | null },
  allowedOrigins: readonly string[],
): boolean {
  const origin = headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
