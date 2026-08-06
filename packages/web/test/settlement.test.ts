import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { countdownLabel, settlementState, SLOW_SETTLE_SECONDS } from "../lib/settlement";

/**
 * The escalation behind the "Drawing..." screen.
 *
 * A healthy relayer settles in seconds and none of this is ever seen. It exists for the
 * relayer being down, where the app used to animate a flickering number indefinitely
 * with the player's stake locked and nothing admitting anything was wrong.
 */

const TIMEOUT = 3600;
const PLACED = 1_000_000;
const SLOW_AT = PLACED + SLOW_SETTLE_SECONDS;

describe("settlementState", () => {
  it("stays quiet while a healthy relayer would still be working", () => {
    const state = settlementState({ placedAt: PLACED, now: PLACED + 3, settleTimeout: TIMEOUT });
    assert.equal(state.phase, "drawing");
  });

  it("explains itself once the settle is slower than a settle should be", () => {
    const state = settlementState({ placedAt: PLACED, now: SLOW_AT, settleTimeout: TIMEOUT });
    assert.equal(state.phase, "slow");
    assert.equal(state.refundableIn, TIMEOUT - SLOW_SETTLE_SECONDS);
  });

  it("offers the refund only once the contract would accept the call", () => {
    const justBefore = settlementState({
      placedAt: PLACED,
      now: PLACED + TIMEOUT - 1,
      settleTimeout: TIMEOUT,
    });
    assert.equal(justBefore.phase, "slow", "one second early is still too early");
    assert.equal(justBefore.refundableIn, 1);

    const atDeadline = settlementState({
      placedAt: PLACED,
      now: PLACED + TIMEOUT,
      settleTimeout: TIMEOUT,
    });
    assert.equal(atDeadline.phase, "refundable");
    assert.equal(atDeadline.refundableIn, 0);
  });

  it("stays refundable well past the deadline rather than wrapping", () => {
    const state = settlementState({
      placedAt: PLACED,
      now: PLACED + TIMEOUT * 10,
      settleTimeout: TIMEOUT,
    });
    assert.equal(state.phase, "refundable");
    assert.equal(state.refundableIn, 0);
  });

  it("survives a head block older than the bet without producing a negative countdown", () => {
    // Chain time is read from the head block, which can briefly lag a reorg.
    const state = settlementState({ placedAt: PLACED, now: PLACED - 30, settleTimeout: TIMEOUT });
    assert.equal(state.phase, "drawing");
    assert.equal(state.refundableIn, TIMEOUT);
  });

  it("tracks the contract's timeout rather than a hard-coded hour", () => {
    const state = settlementState({ placedAt: PLACED, now: PLACED + 100, settleTimeout: 120 });
    assert.equal(state.phase, "slow");
    assert.equal(state.refundableIn, 20);
  });
});

describe("countdownLabel", () => {
  it("counts seconds under a minute", () => {
    assert.equal(countdownLabel(45), "45 seconds");
    assert.equal(countdownLabel(1), "1 second");
  });

  it("counts minutes above one, rounding up so it never promises early", () => {
    assert.equal(countdownLabel(60), "1 minute");
    assert.equal(countdownLabel(61), "2 minutes");
    assert.equal(countdownLabel(3555), "60 minutes");
  });

  it("says now at zero", () => {
    assert.equal(countdownLabel(0), "now");
  });
});
