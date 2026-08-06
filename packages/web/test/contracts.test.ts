import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GAME_ABI } from "../lib/contracts";

/**
 * The `bets(betId)` tuple is destructured *positionally* in `useBetHistory` and in
 * the verify page, because viem returns it as an array. That makes the field order
 * in the ABI load bearing in a way nothing else here is: reorder the struct on chain
 * without reordering this, and every field decodes into its neighbour. The values are
 * all plausible - an address is still an address, a uint256 still a uint256 - so
 * nothing throws and nothing looks wrong until a player's stake reads as their seed.
 *
 * The contract tests cannot catch it. Typechain hands Solidity structs back as named
 * tuples, so they pass whatever the order is. This is the only place the order is
 * checked against what the callers assume.
 *
 * Packed for gas in #47: `settled` and `placedAt` sit between `tier` and `stake`
 * because that is where they live in storage, sharing a slot with `player` and `tier`.
 */
describe("GAME_ABI bets() tuple", () => {
  const entry = GAME_ABI.find((f) => "name" in f && f.name === "bets");
  const outputs: readonly { readonly name?: string; readonly type: string }[] =
    entry && "outputs" in entry ? entry.outputs : [];

  it("is declared, with outputs", () => {
    assert.ok(entry, "GAME_ABI has no bets entry");
    assert.equal(outputs.length, 8);
  });

  it("keeps the field order its callers destructure by position", () => {
    assert.deepEqual(
      outputs.map((o) => o.name),
      ["player", "tier", "settled", "placedAt", "stake", "clientSeed", "commit", "reveal"],
    );
  });

  it("keeps the widths the packed struct declares", () => {
    assert.deepEqual(
      outputs.map((o) => o.type),
      ["address", "uint8", "bool", "uint64", "uint256", "uint256", "bytes32", "bytes32"],
    );
  });
});
