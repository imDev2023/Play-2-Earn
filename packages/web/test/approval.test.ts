import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { maxUint256 } from "viem";
import { approvalAmount, betsCovered, BETS_PER_APPROVAL } from "../lib/approval";

/**
 * The size of the spending approval, which used to be `maxUint256`.
 *
 * The reasoning for a bounded budget lives in lib/approval.ts. What these cases pin
 * down is the arithmetic: that the amount is finite, that it covers a run of bets, and
 * that the two clamps hold at their boundaries. Expected values are written out in
 * full rather than derived from `BETS_PER_APPROVAL`, so a change to the budget has to
 * be argued with here rather than silently followed.
 */

const RUSH = (n: bigint) => n * 10n ** 18n;

describe("approvalAmount", () => {
  it("covers a run of bets, so repeat rolls need no second prompt", () => {
    assert.equal(approvalAmount({ stake: RUSH(100n), balance: RUSH(10_000n) }), RUSH(5000n));
  });

  it("budgets exactly BETS_PER_APPROVAL bets when the balance allows", () => {
    assert.equal(BETS_PER_APPROVAL, 50n);
    assert.equal(betsCovered(approvalAmount({ stake: RUSH(7n), balance: maxUint256 }), RUSH(7n)), 50);
  });

  it("is never unlimited - the whole point of the change", () => {
    const amount = approvalAmount({ stake: RUSH(100n), balance: maxUint256 });
    assert.ok(amount < maxUint256);
    assert.equal(amount, RUSH(5000n));
  });

  it("never approves more than the player actually holds", () => {
    // 50 bets of 100 would be 5000, but they hold 1000. Approving beyond the balance
    // inflates the number in the prompt without buying a single extra roll.
    assert.equal(approvalAmount({ stake: RUSH(100n), balance: RUSH(1000n) }), RUSH(1000n));
  });

  it("still covers the bet being placed when the balance barely covers it", () => {
    // The affordability gate (#42) refuses a stake above the balance before we get
    // here, so the two are equal at worst. Approving less would guarantee a revert.
    assert.equal(approvalAmount({ stake: RUSH(100n), balance: RUSH(100n) }), RUSH(100n));
  });

  it("covers the stake even if the balance somehow reads lower", () => {
    // Defensive: a stale balance read must not produce an approval too small for the
    // transfer it is about to authorise.
    assert.equal(approvalAmount({ stake: RUSH(100n), balance: RUSH(1n) }), RUSH(100n));
  });

  it("falls back to the full budget when the balance has not been read yet", () => {
    assert.equal(approvalAmount({ stake: RUSH(100n), balance: undefined }), RUSH(5000n));
  });
});

describe("betsCovered", () => {
  it("counts the rolls a budget pays for", () => {
    assert.equal(betsCovered(RUSH(5000n), RUSH(100n)), 50);
  });

  it("reports what the balance cap actually bought, not the budget we asked for", () => {
    // The copy has to match the prompt the player just approved, or it is a lie.
    const stake = RUSH(100n);
    const amount = approvalAmount({ stake, balance: RUSH(1000n) });
    assert.equal(betsCovered(amount, stake), 10);
  });

  it("rounds down, because a partial bet is not a bet", () => {
    assert.equal(betsCovered(RUSH(250n), RUSH(100n)), 2);
  });

  it("reports zero rather than dividing by zero on an empty stake", () => {
    assert.equal(betsCovered(RUSH(100n), 0n), 0);
  });
});
