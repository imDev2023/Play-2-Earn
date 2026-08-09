import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";

/**
 * Mints a per-request nonce and attaches the Content-Security-Policy.
 *
 * This exists as middleware rather than a static header in `next.config` because a
 * useful `script-src` needs a nonce, and a nonce is per response by definition. Next
 * reads it back off the request header below and stamps it onto every script it
 * injects, which is what lets the policy be `'strict-dynamic'` instead of a list of
 * chunk URLs that would go stale on every build.
 *
 * The static headers - framing, sniffing, referrer, HSTS - are set in `next.config`
 * instead, so that they also cover responses this matcher deliberately skips.
 *
 * The cost is that pages are no longer statically optimised. That is close to free
 * here: every route in this app reads chain state in the browser, so nothing was being
 * served from the static cache that a player actually saw.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, { isDev: process.env.NODE_ENV !== "production" });

  // Next looks for exactly this header to stamp the nonce onto its own script tags.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own build output and the favicon. Those are static
     * assets with no scripts to nonce, and running a nonce mint per asset request
     * would defeat their caching for nothing.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
