import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { foldBetLogs, hydrateEntry, playerBetIds } from "../lib/useBetHistory";

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

/**
 * The ids driving `hydrate`, which is the recovery path for a bet whose events this
 * session missed.
 *
 * These used to be read back out of a `setDrafts` updater, which React is free to defer
 * - so by the time the handler asked for them the list was still empty and the whole
 * hydrate pass quietly did nothing. Deriving them from the logs is what makes the call
 * independent of React's scheduling, so they are worth pinning here.
 */
describe("playerBetIds", () => {
  const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  it("returns the ids of this player's logs, in order", () => {
    assert.deepEqual(
      playerBetIds(
        [{ args: { betId: 7n, player: PLAYER } }, { args: { betId: 9n, player: PLAYER } }],
        PLAYER,
      ),
      [7n, 9n],
    );
  });

  it("ignores another player's logs", () => {
    // The events are chain-wide, so somebody else settling must not pull this player's
    // screen into hydrating a bet that is none of its business.
    assert.deepEqual(
      playerBetIds(
        [{ args: { betId: 7n, player: OTHER } }, { args: { betId: 9n, player: PLAYER } }],
        PLAYER,
      ),
      [9n],
    );
  });

  it("matches regardless of address casing", () => {
    assert.deepEqual(
      playerBetIds([{ args: { betId: 7n, player: PLAYER.toLowerCase() } }], PLAYER.toUpperCase()),
      [7n],
    );
  });

  it("returns nothing when there is no connected address", () => {
    // Guards against the undefined-equals-undefined trap: a log with no player must not
    // match a disconnected wallet.
    assert.deepEqual(playerBetIds([{ args: { betId: 7n } }], undefined), []);
  });

  it("skips a log with no betId", () => {
    assert.deepEqual(playerBetIds([{ args: { player: PLAYER } }], PLAYER), []);
  });
});

/**
 * Hydration must never lose ground to the events it exists to back up.
 *
 * `hydrate` reads `bets(betId)` after a BetPlaced, and that read races the settlement:
 * the reply is a snapshot from before it landed, so it can arrive after BetSettled has
 * already supplied the reveal. Writing the snapshot straight over the row erased it, and
 * `verifyInputsFor` needs clientSeed, commit and reveal together - so the fairness
 * verdict disappeared from a row that had just shown one, which is the same symptom the
 * dropped-subscription bug produced, reached from the other side.
 */
describe("hydrateEntry", () => {
  const ZERO = `0x${"0".repeat(64)}` as const;
  const COMMIT = `0x${"ab".repeat(32)}` as const;
  const REVEAL = `0x${"cd".repeat(32)}` as const;

  const settled = {
    betId: 40n,
    tier: 0,
    stake: RUSH(100n),
    outcome: "won" as const,
    payout: RUSH(190n),
    clientSeed: 7n,
    commit: COMMIT,
    reveal: REVEAL,
  };

  it("keeps a reveal the event supplied when the chain read predates settlement", () => {
    const merged = hydrateEntry(settled, {
      tier: 0,
      stake: RUSH(100n),
      clientSeed: 7n,
      commit: COMMIT,
      // The read was taken while the bet was still unsettled, so the slot is zero.
      reveal: ZERO,
    });
    assert.equal(merged.reveal, REVEAL);
  });

  it("supplies a reveal the events never delivered", () => {
    const pending = { ...settled, outcome: "pending" as const, reveal: undefined };
    const merged = hydrateEntry(pending, {
      tier: 0,
      stake: RUSH(100n),
      clientSeed: 7n,
      commit: COMMIT,
      reveal: REVEAL,
    });
    assert.equal(merged.reveal, REVEAL);
  });

  it("returns the same object when nothing changed, so the row does not re-render", () => {
    const merged = hydrateEntry(settled, {
      tier: 0,
      stake: RUSH(100n),
      clientSeed: 7n,
      commit: COMMIT,
      reveal: REVEAL,
    });
    assert.equal(merged, settled);
  });

  it("does not erase a commit with an empty slot", () => {
    const merged = hydrateEntry(settled, {
      tier: 0,
      stake: RUSH(100n),
      clientSeed: 7n,
      commit: ZERO,
      reveal: REVEAL,
    });
    assert.equal(merged.commit, COMMIT);
  });
});
