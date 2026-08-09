import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BETS_FIELDS, GAME_ABI, toBetView, type RawBet } from "../lib/contracts";

/**
 * `refund` is the player's guarantee that a relayer which never settles cannot keep
 * their stake. It has always existed on-chain and was missing from this ABI entirely,
 * so nothing in the app could reach it and nothing on screen mentioned it.
 */
describe("GAME_ABI refund()", () => {
  it("exposes refund, so a stalled bet has a way out", () => {
    const refund = GAME_ABI.find((entry) => entry.type === "function" && entry.name === "refund");
    assert.ok(refund, "refund(betId) must be reachable from the play screen");
    assert.deepEqual(
      (refund as { inputs: readonly { name: string; type: string }[] }).inputs.map((i) => i.type),
      ["uint256"],
    );
  });

  it("exposes BetRefunded, since a refunded bet never emits BetSettled", () => {
    const event = GAME_ABI.find((entry) => entry.type === "event" && entry.name === "BetRefunded");
    assert.ok(event, "without this the draw keeps animating after the stake came back");
  });
});

/**
 * These tests deliberately assert **order independence**, not a particular order.
 *
 * An earlier version hard-coded the tuple as it stands today. That was the positional
 * trap all over again: #48 repacks the struct to `player, tier, settled, placedAt,
 * stake, ...`, the two changes touch different lines, so they would have merged clean
 * and left this file asserting falsehoods against a decoder that had silently started
 * reading `settled` out of the stake slot.
 *
 * `toBetView` now zips against the `bets()` entry in `GAME_ABI` - the same declaration
 * viem decodes against - so the correct test is that a value placed at the position the
 * ABI declares for a field comes back under that field's name, whatever the order is.
 */
describe("toBetView", () => {
  /**
   * A distinct sentinel per slot, so no field can be confused with its neighbour. The
   * cast is the point of the test rather than a hole in it: production gets `RawBet`
   * from viem, and these values are deliberately the wrong shape for it so that the
   * mapping alone is under test.
   */
  const raw = BETS_FIELDS.map((_, index) => 1000n + BigInt(index)) as unknown as RawBet;

  it("reads every field from the slot the ABI declares for it", () => {
    const view = toBetView(raw) as unknown as Record<string, unknown>;
    BETS_FIELDS.forEach((field, index) => {
      assert.equal(
        view[field],
        raw[index],
        `${field} must come from slot ${index}, the position bets() declares it at`,
      );
    });
  });

  it("names every field bets() returns, and invents none", () => {
    const view = toBetView(raw) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(view).sort(), [...BETS_FIELDS].sort());
  });
});

/**
 * Separate from `toBetView` on purpose: this pins the ABI itself, not the mapping.
 *
 * It is the one assertion here that is not circular. Everything above derives its
 * expectations from `GAME_ABI` and so stays green through a rename; this names the
 * fields the app reads in prose, so dropping or renaming one turns it red. The recovery
 * path in `PlayPanel` reads `settled`, `placedAt`, `player` and `tier`, and losing any of
 * them silently would strand a player on a draw that never resolves.
 *
 * It stops at names. Pinning the declared *order and widths* against the contract is
 * `test/contracts.test.ts`, which belongs to #48 because #48 creates that same path.
 */
describe("GAME_ABI bets()", () => {
  it("still declares every field the app reads", () => {
    for (const needed of ["player", "tier", "settled", "placedAt", "stake"]) {
      const names: readonly string[] = BETS_FIELDS;
      assert.ok(names.includes(needed), `bets() must still return ${needed}`);
    }
  });
});
