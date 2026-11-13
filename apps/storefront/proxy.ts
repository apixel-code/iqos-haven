import { NextResponse, type NextRequest } from "next/server";
import { AGE_COOKIE, signAgeTicket } from "@ih/platform/age-ticket";
import { isVerifiedCrawler } from "@/lib/age/crawler";
import { verifyRequestTicket } from "@/lib/age/handlers";
import { ageCookie, gateAction, hasRestrictedCookie } from "@/lib/age/policy";
import { ageGate } from "@/lib/age/runtime";
import { crawlerMayRead, INDEXABLE_HEADER, pageIsIndexable, readSeoPolicy } from "@/lib/seo-policy";

/** How long a verified crawler's pass lasts: one page and what it loads, not a browsing session. */
const CRAWLER_PASS_SECONDS = 600;

/**
 * Routing gate (roadmap step 56, architecture §9). Runs before every page, RSC and route
 * request: without a valid signed age ticket nothing but the gate pages is rendered. The decision
 * uses the signed cookie only; never the User-Agent or any other client hint. The API checks the
 * same ticket again on every store request, so this gate is not the only line.
 *
 * One exception (ADR 0114): while the Owner offers the catalogue to search engines, a crawler
 * whose address is confirmed by DNS reads catalogue pages with a short-lived ticket minted here.
 * The User-Agent alone grants nothing.
 */
export async function proxy(request: NextRequest) {
  const { runtime } = ageGate();
  const cookieHeader = request.headers.get("cookie");
  const { pathname } = request.nextUrl;
  const policy = await readSeoPolicy();
  const ticket = verifyRequestTicket(runtime, cookieHeader);
  let pass: string | undefined;
  if (!ticket.ok && runtime.signer && crawlerMayRead(policy, request.method, pathname)) {
    const address = request.headers.get("x-ih-client-ip");
    if (await isVerifiedCrawler(request.headers.get("user-agent"), address))
      pass = signAgeTicket(runtime.signer, {
        policyVersion: runtime.policyVersion,
        ttlSeconds: CRAWLER_PASS_SECONDS,
      }).ticket;
  }
  const action = pass
    ? ({ kind: "allow" } as const)
    : gateAction({
        pathname,
        search: request.nextUrl.search,
        ticket,
        restricted: hasRestrictedCookie(cookieHeader),
      });
  const indexable = pageIsIndexable(policy, pathname);
  let response: NextResponse;
  if (action.kind === "allow") {
    // Pages read this for their robots meta; a client can never supply it.
    const forwarded = new Headers(request.headers);
    forwarded.delete(INDEXABLE_HEADER);
    if (indexable) forwarded.set(INDEXABLE_HEADER, "1");
    if (pass) forwarded.set("cookie", `${AGE_COOKIE}=${pass}`);
    response = NextResponse.next({ request: { headers: forwarded } });
    // What the crawler's page loads afterwards (pictures, data) carries the same pass.
    if (pass) response.headers.append("Set-Cookie", ageCookie(pass, CRAWLER_PASS_SECONDS));
  } else {
    // Next needs an absolute URL here and sends a same-origin one as a relative Location.
    // The base is the request origin only when it is one of ours; a forged Host header
    // falls back to the configured storefront origin. 303 for anything but GET/HEAD so a
    // refused POST is never replayed at the gate page.
    response = NextResponse.redirect(
      new URL(
        action.location,
        runtime.origins.includes(request.nextUrl.origin)
          ? request.nextUrl.origin
          : runtime.origins[0],
      ),
      request.method === "GET" || request.method === "HEAD" ? 307 : 303,
    );
  }
  // Gated and gate responses depend on the cookie: never store or share them.
  response.headers.set("Cache-Control", "private, no-store");
  // Everything is noindex unless the Owner's policy offers this exact page (ADRs 0079, 0114).
  // Only exact lower-case paths are ever offered, so another spelling (`/Terms`) stays noindex.
  if (!indexable) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  // Build assets carry no catalogue data. Everything else passes through the gate, including
  // the image optimizer (`/_next/image`), which could otherwise serve product images.
  matcher: ["/((?!_next/static|favicon.ico).*)"],
};
