import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { foldBetLogs } from "../lib/useBetHistory";

/**
 * A refunded bet used to read "pending" for ever.
 *
 * `refund` settles nothing, so it emits `BetRefunded` and never `BetSettled`, and
 * history folded only the latter. The stake was already back in the player's wallet
 * while the row still claimed the draw was in flight - the same silence the settlement
 * panel exists to end, one section further down the page.
 *
 * Refunded is its own outcome. Folding it into "lost" would be worse than pending: the
 * player lost nothing.
 */

const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RUSH = (n: bigint) => n * 10n ** 18n;

describe("bet history outcomes", () => {
  it("closes a refunded bet as refunded, not pending", () => {
    const history = foldBetLogs([
      { kind: "placed", args: { betId: 27n, player: PLAYER, tier: 0, stake: RUSH(100n) } },
      { kind: "refunded", args: { betId: 27n, player: PLAYER, amount: RUSH(100n) } },
    ]);
    assert.equal(history[0].outcome, "refunded");
    assert.equal(history[0].payout, RUSH(100n));
  });

  it("keeps a settled bet's outcome untouched", () => {
    const won = foldBetLogs([
      { kind: "placed", args: { betId: 28n, player: PLAYER, tier: 0, stake: RUSH(100n) } },
      { kind: "settled", args: { betId: 28n, player: PLAYER, win: true, payout: RUSH(190n) } },
    ]);
    assert.equal(won[0].outcome, "won");

    const lost = foldBetLogs([
      { kind: "placed", args: { betId: 29n, player: PLAYER, tier: 0, stake: RUSH(100n) } },
      { kind: "settled", args: { betId: 29n, player: PLAYER, win: false, payout: 0n } },
    ]);
    assert.equal(lost[0].outcome, "lost");
  });

  it("leaves a bet that has neither settled nor refunded as pending", () => {
    const history = foldBetLogs([
      { kind: "placed", args: { betId: 30n, player: PLAYER, tier: 0, stake: RUSH(100n) } },
    ]);
    assert.equal(history[0].outcome, "pending");
  });

  it("keeps the tier and stake the placement reported", () => {
    const history = foldBetLogs([
      { kind: "placed", args: { betId: 31n, player: PLAYER, tier: 5, stake: RUSH(10n) } },
      { kind: "refunded", args: { betId: 31n, player: PLAYER, amount: RUSH(10n) } },
    ]);
    assert.equal(history[0].tier, 5);
    assert.equal(history[0].stake, RUSH(10n));
  });

  it("survives a refund whose placement this session never saw", () => {
    // Backfill and live events can arrive in either order, and a refund carries the
    // amount, so the row is still worth something without the BetPlaced.
    const history = foldBetLogs([
      { kind: "refunded", args: { betId: 32n, player: PLAYER, amount: RUSH(100n) } },
    ]);
    assert.equal(history[0].outcome, "refunded");
    assert.equal(history[0].stake, RUSH(100n));
  });
});
