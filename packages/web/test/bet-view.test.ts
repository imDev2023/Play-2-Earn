import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GAME_ABI, toBetView } from "../lib/contracts";

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
 * `bets()` is a struct getter, so viem returns a positional array and every caller
 * destructures it by position - this repo's sharpest edge, because a reorder decodes
 * each field into its neighbour without throwing.
 *
 * The ABI's declared order is pinned in `contracts.test.ts`, which belongs to the
 * storage-packing change (#48) that is repacking the struct. This file covers only the
 * mapping itself.
 */
describe("toBetView", () => {
  it("names the fields the tuple returns positionally", () => {
    const view = toBetView([
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      3,
      100n,
      7n,
      1_785_902_511n,
      false,
      "0xaa",
      "0xbb",
    ]);
    assert.equal(view.player, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    assert.equal(view.tier, 3);
    assert.equal(view.settled, false);
  });

  it("keeps stake, clientSeed and placedAt distinct - the swap that still type-checks", () => {
    const view = toBetView([
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      0,
      1n,
      2n,
      3n,
      true,
      "0x00",
      "0x00",
    ]);
    assert.equal(view.stake, 1n);
    assert.equal(view.clientSeed, 2n);
    assert.equal(view.placedAt, 3n);
  });
});
