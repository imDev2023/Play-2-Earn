import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GAME_ABI, toBetView } from "../lib/contracts";

/**
 * The `bets()` tuple order, pinned.
 *
 * This is the repo's sharpest edge. `bets()` is a struct getter, viem returns a
 * positional array, and the relayer reads it through a hand-written ABI fragment. A
 * reorder therefore decodes every field into its neighbour and throws nothing at all,
 * because an address is still an address and a uint is still a uint. Contract tests
 * cannot catch it either: typechain returns named tuples and passes any order.
 *
 * So the order is asserted here as data, where a reorder is a failing test rather than
 * a frontend quietly showing `placedAt` as a stake.
 */
describe("GAME_ABI bets()", () => {
  const bets = GAME_ABI.find((entry) => entry.type === "function" && entry.name === "bets");

  it("is declared", () => {
    assert.ok(bets, "bets() must be in the ABI the frontend reads");
  });

  it("declares its outputs in the order the contract returns them", () => {
    const outputs = (bets as { outputs: readonly { name: string; type: string }[] }).outputs;
    assert.deepEqual(
      outputs.map((o) => [o.name, o.type]),
      [
        ["player", "address"],
        ["tier", "uint8"],
        ["stake", "uint256"],
        ["clientSeed", "uint256"],
        ["placedAt", "uint256"],
        ["settled", "bool"],
        ["commit", "bytes32"],
        ["reveal", "bytes32"],
      ],
      "the bets() tuple changed shape - every positional consumer must move with it",
    );
  });
});

/**
 * `refund` is the player's guarantee that a relayer which never settles cannot keep
 * their stake. It existed on-chain and was missing from this ABI entirely, so nothing
 * in the app could reach it.
 */
describe("GAME_ABI refund()", () => {
  it("exposes refund so a stalled bet has a way out", () => {
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
    assert.equal(view.stake, 100n);
    assert.equal(view.clientSeed, 7n);
    assert.equal(view.placedAt, 1_785_902_511n);
    assert.equal(view.settled, false);
  });

  it("keeps stake, clientSeed and placedAt distinct, which is the swap that type-checks", () => {
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
