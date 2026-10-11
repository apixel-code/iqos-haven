import type { IncomingHttpHeaders } from "node:http";

/**
 * Origin/CSRF controls (architecture §11 "Security controls"). Admin sessions are SameSite=Strict
 * `__Host-` cookies; on top of that every state-changing request must come from an allowlisted
 * Origin of the surface it targets, is refused when the browser marks it cross-site, and may only
 * carry a JSON body. A cross-site form or `text/plain` beacon therefore never reaches a handler.
 * No CSRF token is needed while every flow is a same-origin JSON fetch (ADR 0005).
 *
 * Internal service routes skip the Origin and Sec-Fetch-Site rules (they carry no cookies and
 * are HMAC-authenticated) but still accept only JSON bodies. Login and logout are covered like any
 * other admin mutation. A state-changing request to any other path is refused (fail closed).
 * Paths are classified after percent-decoding and slash collapsing, as the router sees them.
 */
export type RouteSurface = "admin" | "store" | "internal" | "other";

export interface AllowedOrigins {
  readonly admin: readonly string[];
  readonly store: readonly string[];
}

export type BrowserRequestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 403 | 415;
      readonly reason:
        "origin_missing" | "origin_not_allowed" | "cross_site" | "content_type" | "unknown_surface";
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Router-equivalent path: no query/fragment, percent-decoded, duplicate slashes collapsed. */
function normalizedPath(url: string): string | null {
  const raw = url.split(/[?#]/, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.replace(/\/{2,}/g, "/").toLowerCase();
}

export function routeSurface(url: string): RouteSurface {
  const path = normalizedPath(url);
  if (path === null) return "other";
  if (path.startsWith("/v1/auth/") || path.startsWith("/v1/admin/")) return "admin";
  if (path.startsWith("/v1/store/")) return "store";
  if (path.startsWith("/v1/internal/")) return "internal";
  return "other";
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function checkBrowserRequest(
  request: { method: string; url: string; headers: IncomingHttpHeaders },
  origins: AllowedOrigins,
): BrowserRequestVerdict {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  const surface = routeSurface(request.url);
  if (surface === "other") return { ok: false, status: 403, reason: "unknown_surface" };
  if (surface !== "internal") {
    const fetchSite = header(request.headers, "sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")
      return { ok: false, status: 403, reason: "cross_site" };
    const origin = header(request.headers, "origin");
    if (!origin) return { ok: false, status: 403, reason: "origin_missing" };
    const allowed = surface === "admin" ? origins.admin : origins.store;
    if (!allowed.includes(origin)) return { ok: false, status: 403, reason: "origin_not_allowed" };
  }
  const hasBody =
    Number(header(request.headers, "content-length") ?? 0) > 0 ||
    header(request.headers, "transfer-encoding") !== undefined;
  if (hasBody) {
    const type = (header(request.headers, "content-type") ?? "").split(";", 1)[0]!.trim();
    if (type.toLowerCase() !== "application/json")
      return { ok: false, status: 415, reason: "content_type" };
  }
  return { ok: true };
}
