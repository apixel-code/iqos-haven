import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestTicket } from "@/lib/age/handlers";
import { gateAction, hasRestrictedCookie } from "@/lib/age/policy";
import { ageGate } from "@/lib/age/runtime";
import { INDEXABLE_PATHS, pageIsIndexable, readSeoPolicy } from "@/lib/seo-policy";

/**
 * Routing gate (roadmap step 56, architecture §9). Runs before every page, RSC and route
 * request: without a valid signed age ticket nothing but the gate pages is rendered. The decision
 * uses the signed cookie only; never the User-Agent or any other client hint. The API checks the
 * same ticket again on every store request, so this gate is not the only line.
 */
export async function proxy(request: NextRequest) {
  const { runtime } = ageGate();
  const cookieHeader = request.headers.get("cookie");
  const action = gateAction({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    ticket: verifyRequestTicket(runtime, cookieHeader),
    restricted: hasRestrictedCookie(cookieHeader),
  });
  const response =
    action.kind === "allow"
      ? NextResponse.next()
      : // Next needs an absolute URL here and sends a same-origin one as a relative Location.
        // The base is the request origin only when it is one of ours; a forged Host header
        // falls back to the configured storefront origin. 303 for anything but GET/HEAD so a
        // refused POST is never replayed at the gate page.
        NextResponse.redirect(
          new URL(
            action.location,
            runtime.origins.includes(request.nextUrl.origin)
              ? request.nextUrl.origin
              : runtime.origins[0],
          ),
          request.method === "GET" || request.method === "HEAD" ? 307 : 303,
        );
  // Gated and gate responses depend on the cookie: never store or share them.
  response.headers.set("Cache-Control", "private, no-store");
  // The policy pages are noindex like everything else unless the Owner offers public pages
  // (step 113); the static config leaves their header to this decision.
  // The static rule matches without regard to case, so `/Terms` also lacks it: only the exact
  // lower-case page may ever go without noindex.
  const { pathname } = request.nextUrl;
  if (
    INDEXABLE_PATHS.includes(pathname.toLowerCase()) &&
    !pageIsIndexable(await readSeoPolicy(), pathname)
  )
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  // Build assets carry no catalogue data. Everything else passes through the gate, including
  // the image optimizer (`/_next/image`), which could otherwise serve product images.
  matcher: ["/((?!_next/static|favicon.ico).*)"],
};
