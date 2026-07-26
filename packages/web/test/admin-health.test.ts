import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LAG_WARNING_SECONDS, relayerHealth } from "../lib/admin/health";

/**
 * The relayer health / settlement-lag indicator.
 *
 * Derived entirely from chain state — an active bet's age against `SETTLE_TIMEOUT` —
 * so it reports the thing the operator actually cares about (are players' bets being
 * settled?) rather than whether some process answers a health check.
 */

const TIMEOUT = 3600n; // RushoodGame.SETTLE_TIMEOUT
const NOW = 1_800_000_000n;

function health(over: Partial<Parameters<typeof relayerHealth>[0]> = {}) {
  return relayerHealth({ activeBetId: 0n, now: NOW, settleTimeout: TIMEOUT, ...over });
}

describe("relayerHealth", () => {
  it("is idle with no bet in flight", () => {
    const result = health();
    assert.equal(result.status, "idle");
    assert.equal(result.pendingSeconds, 0n);
    assert.equal(result.healthy, true);
  });

  it("is settling while a fresh bet is in flight", () => {
    const result = health({ activeBetId: 7n, placedAt: NOW - 3n });
    assert.equal(result.status, "settling");
    assert.equal(result.pendingSeconds, 3n);
    assert.equal(result.healthy, true);
  });

  it("flags a bet the relayer has not settled within the warning window", () => {
    const result = health({ activeBetId: 7n, placedAt: NOW - LAG_WARNING_SECONDS });
    assert.equal(result.status, "lagging");
    assert.equal(result.healthy, false);
    // The operator's next question is always "how long until players can walk away".
    assert.equal(result.refundableIn, TIMEOUT - LAG_WARNING_SECONDS);
  });

  it("reports a bet past the settle timeout as stalled and refundable", () => {
    const result = health({ activeBetId: 7n, placedAt: NOW - TIMEOUT });
    assert.equal(result.status, "stalled");
    assert.equal(result.healthy, false);
    assert.equal(result.refundableIn, 0n);
  });

  it("cannot know its status before the chain answers", () => {
    // An active bet whose record has not loaded is not "healthy by default".
    const result = health({ activeBetId: 7n });
    assert.equal(result.status, "unknown");
    assert.equal(result.healthy, false);
  });

  it("treats a bet timestamped in the future as zero lag rather than negative", () => {
    // Block timestamps and the browser clock disagree; a skewed clock must not render
    // a nonsensical "-4s pending".
    const result = health({ activeBetId: 7n, placedAt: NOW + 4n });
    assert.equal(result.pendingSeconds, 0n);
    assert.equal(result.status, "settling");
  });

  it("carries the last observed settlement lag through untouched", () => {
    const result = health({ lastSettleLag: 2n });
    assert.equal(result.lastSettleLag, 2n);
  });
});
