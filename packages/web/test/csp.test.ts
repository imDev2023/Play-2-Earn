import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { STATIC_SECURITY_HEADERS, contentSecurityPolicy } from "../lib/csp";
import { rpcEndpoints } from "../lib/endpoints";

/**
 * The headers that defend the signing surface.
 *
 * These are asserted rather than eyeballed because a CSP fails in two opposite ways and
 * both are quiet: too tight and the app cannot reach its own chain, too loose and it
 * protects nothing. Neither shows up in a typecheck.
 */

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

describe("contentSecurityPolicy", () => {
  it("refuses to be framed, which is the attack this app is shaped for", () => {
    // The flow is "read this, then press the button that opens your wallet". Framed and
    // overlaid, the click a player believes lands on a coin flip lands on an approval,
    // and the contracts cannot tell the difference because the player did authorise it.
    assert.equal(
      directive(contentSecurityPolicy("n"), "frame-ancestors"),
      "frame-ancestors 'none'",
    );
  });

  it("carries the nonce it was given, so Next's own scripts are the only ones that run", () => {
    const policy = contentSecurityPolicy("abc123");
    const scriptSrc = directive(policy, "script-src") ?? "";
    assert.ok(scriptSrc.includes("'nonce-abc123'"), scriptSrc);
    assert.ok(scriptSrc.includes("'strict-dynamic'"), scriptSrc);
  });

  it("never allows unsafe-eval in a production policy", () => {
    assert.ok(!contentSecurityPolicy("n").includes("'unsafe-eval'"));
  });

  it("allows exactly the chains the app is configured to talk to", () => {
    // Built from lib/endpoints, the same module the chain definitions read, so the
    // policy cannot drift from the app and lock it out of its own RPC.
    const connect = directive(contentSecurityPolicy("n"), "connect-src") ?? "";
    for (const endpoint of rpcEndpoints()) {
      assert.ok(connect.includes(endpoint), `${endpoint} missing from ${connect}`);
    }
  });

  it("does not allow a page script to post anywhere it likes", () => {
    // connect-src is what stops an injected script shipping an address, a balance or a
    // bet history somewhere else.
    const connect = directive(contentSecurityPolicy("n"), "connect-src") ?? "";
    assert.ok(!connect.includes("*"), connect);
    assert.equal(directive(contentSecurityPolicy("n"), "form-action"), "form-action 'none'");
    assert.equal(directive(contentSecurityPolicy("n"), "object-src"), "object-src 'none'");
    assert.equal(directive(contentSecurityPolicy("n"), "base-uri"), "base-uri 'self'");
  });

  it("loosens only what the dev server needs, and only in development", () => {
    const dev = contentSecurityPolicy("n", { isDev: true });
    assert.ok((directive(dev, "script-src") ?? "").includes("'unsafe-eval'"));
    assert.ok((directive(dev, "connect-src") ?? "").includes("ws:"));
    // Upgrading insecure requests locally would break the http dev RPC endpoint.
    assert.ok(!dev.includes("upgrade-insecure-requests"));
    assert.ok(contentSecurityPolicy("n").includes("upgrade-insecure-requests"));
  });
});

describe("STATIC_SECURITY_HEADERS", () => {
  it("names every header the app relies on being set", () => {
    const keys = STATIC_SECURITY_HEADERS.map((h) => h.key);
    for (const expected of [
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Strict-Transport-Security",
    ]) {
      assert.ok(keys.includes(expected), `${expected} missing from ${keys.join(", ")}`);
    }
  });

  it("does not leak a full referrer, because roll data travels in the query string", () => {
    const referrer = STATIC_SECURITY_HEADERS.find((h) => h.key === "Referrer-Policy");
    assert.equal(referrer?.value, "strict-origin-when-cross-origin");
  });

  it("denies the payment and camera APIs a dapp has no business asking for", () => {
    const permissions = STATIC_SECURITY_HEADERS.find((h) => h.key === "Permissions-Policy");
    assert.ok(permissions?.value.includes("payment=()"), permissions?.value);
    assert.ok(permissions?.value.includes("camera=()"), permissions?.value);
  });
});
