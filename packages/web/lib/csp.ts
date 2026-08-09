import { rpcEndpoints } from "./endpoints";

/**
 * The security headers every response carries.
 *
 * A dapp is a signing surface, and the headers below are the part of protecting it that
 * belongs to the web server rather than to the contracts. Absent them, a page that asks
 * people to approve token spends can be framed, sniffed and pointed at hosts it was
 * never meant to talk to.
 *
 * `frame-ancestors 'none'` is the one that matters most here. RUSHOOD's whole flow is
 * "read this, then press the button that opens your wallet", which is exactly what
 * clickjacking defeats: an attacker frames the real app, overlays their own chrome, and
 * the click a player believes lands on a coin flip lands on an approval instead. The
 * contracts cannot help - the transaction is genuinely authorised by the player.
 *
 * `connect-src` is the second: it is the list of hosts the page may talk to, so a script
 * that got onto the page cannot quietly ship an address, a balance or a bet history to
 * somewhere else. It is built from the same module the chains are configured from, so
 * the policy cannot drift from the app (see lib/endpoints).
 */

/** Headers that need no per-request state, so `next.config` can set them statically. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  // Belt and braces with `frame-ancestors`, which supersedes it in browsers that
  // implement CSP. Kept because the two disagree about nothing and the older header is
  // still what some embedded webviews honour.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Bet ids and commitments travel in the verifier's query string, so a full referrer
  // would hand a player's roll to whatever they click through to.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // None of these are used, and a dapp asking for the payment API is a phishing tell.
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  },
  // Ignored over plain http, so this is inert locally and load-bearing in production.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

/**
 * The Content-Security-Policy for one request.
 *
 * `nonce` is minted per request by the middleware; Next stamps it onto the scripts it
 * injects, and `strict-dynamic` lets those scripts load the app's own chunks without
 * every chunk URL having to be enumerated here.
 *
 * `style-src` has to allow `'unsafe-inline'`, and that is a considered choice rather
 * than an oversight: the visual system is React inline style objects, which become
 * `style` attributes, and attributes cannot carry a nonce. Rewriting the whole UI to
 * classes to tighten a directive that does not stop script execution would be a large
 * change for very little, so the protection here is concentrated on `script-src` and
 * `connect-src`, which are what an injected script actually needs.
 *
 * Development adds `'unsafe-eval'` because the dev server's hot reloader needs it, and
 * websocket origins for the same reason. Neither reaches production.
 */
export function contentSecurityPolicy(nonce: string, { isDev = false } = {}): string {
  const connect = ["'self'", ...rpcEndpoints()];
  if (isDev) {
    // The dev server talks to itself over ws for hot reload.
    connect.push("ws:", "wss:");
  }

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    // The app embeds nothing and is embedded by nobody.
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    // There is no form in the app; anything posting somewhere is not ours.
    "form-action": ["'none'"],
    "base-uri": ["'self'"],
  };

  const rendered = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  // Only meaningful over https, and in dev it would break the http RPC endpoint.
  return isDev ? rendered : `${rendered}; upgrade-insecure-requests`;
}
