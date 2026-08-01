import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { betBlock, betBlockMessage } from "../lib/bet-validity";

/**
 * The gate in front of `placeBet`.
 *
 * It exists because placing a bet asks the wallet for a spending approval before it
 * asks the chain for anything. A stake the player cannot cover therefore used to cost
 * them an approval prompt, flagged red by their wallet because the approval is
 * unlimited, followed by a revert inside an ERC-20 transfer whose message named
 * `transferFrom` rather than their balance. Every case here is knowable from state
 * already on screen.
 */

const RUSH = (n: bigint) => n * 10n ** 18n;
const MIN = RUSH(1n);
const MAX = RUSH(5263n);

describe("betBlock", () => {
  it("allows a stake inside the bounds that the player can cover", () => {
    assert.equal(
      betBlock({ stake: RUSH(100n), minBet: MIN, maxBet: MAX, balance: RUSH(10_000n) }),
      null,
    );
  });

  it("blocks a stake below the minimum bet", () => {
    assert.equal(
      betBlock({ stake: 1n, minBet: MIN, maxBet: MAX, balance: RUSH(10_000n) }),
      "below-min",
    );
  });

  it("blocks a stake above the tier's max", () => {
    assert.equal(
      betBlock({ stake: RUSH(6000n), minBet: MIN, maxBet: MAX, balance: RUSH(10_000n) }),
      "above-max",
    );
  });

  /** The reported bug: 5000 RUSH staked from an account holding none. */
  it("blocks a stake the player cannot afford", () => {
    assert.equal(betBlock({ stake: RUSH(5000n), minBet: MIN, maxBet: MAX, balance: 0n }), "below-min-balance");
    assert.equal(
      betBlock({ stake: RUSH(5000n), minBet: MIN, maxBet: MAX, balance: RUSH(100n) }),
      "unaffordable",
    );
  });

  /**
   * The contract's own bounds come first. Telling someone to buy more tokens for a bet
   * the game would reject anyway sends them to spend money on a dead end.
   */
  it("reports an out-of-bounds stake before an unaffordable one", () => {
    assert.equal(betBlock({ stake: RUSH(9999n), minBet: MIN, maxBet: MAX, balance: 0n }), "above-max");
  });

  it("says nothing while the chain reads are still in flight", () => {
    assert.equal(betBlock({ stake: RUSH(100n), minBet: undefined, maxBet: undefined }), null);
    assert.equal(betBlock({ stake: null, minBet: MIN, maxBet: MAX, balance: 0n }), null);
  });
});

describe("betBlockMessage", () => {
  /** Lowering the stake is a dead end when the whole balance is under the minimum. */
  it("does not tell a player under the minimum to lower their stake", () => {
    const message = betBlockMessage("below-min-balance", 0n);
    assert.match(String(message), /less than the minimum bet/);
    assert.doesNotMatch(String(message), /Lower the stake/);
  });

  it("tells a player who can merely afford less what they hold", () => {
    assert.equal(
      betBlockMessage("unaffordable", RUSH(100n)),
      "You hold 100 RUSH. Lower the stake or get more.",
    );
  });

  it("says nothing when nothing is blocking", () => {
    assert.equal(betBlockMessage(null), null);
  });
});
