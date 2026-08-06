import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GAME_ABI, RUSH_ABI } from "../lib/contracts";

/**
 * The hand-written ABIs in `lib/contracts.ts`, checked against the contracts themselves.
 *
 * This closes a whole class of bug rather than one instance of it. viem decodes against
 * whatever `GAME_ABI` says, and `GAME_ABI` is typed out by hand, so any disagreement with
 * the deployed Solidity is decoded silently: a reordered struct puts every field in its
 * neighbour's slot, and nothing throws, because an address is still an address and a uint
 * is still a uint. Every guard the repo had for this pinned the ABI against *another
 * hand-written list* - `test/contracts.test.ts` on #48 spells the expected order out
 * literally, and `toBetView` derives from the ABI, which is only as right as the ABI is.
 * Each of those catches a careless edit. None catches the case where someone changes
 * `RushoodGame.sol` and updates neither.
 *
 * The relayer already had the right idea: `packages/contracts/test/RelayerService.ts`
 * checks its hand-written fragments against the compiled contract. This is that check,
 * for the frontend, and it is deliberately not limited to `bets()` - a reorder is simply
 * the sharpest way this fails, not the only one. A reordered or widened field, a renamed
 * event argument or struct-getter output, a flipped `indexed`, a function that quietly
 * became `payable`, one that no longer exists: each decodes or encodes wrongly, and each
 * is caught here.
 *
 * The ABI is allowed to be a *subset* of the contract. The frontend does not need every
 * function, and requiring it to declare them all would make this test a chore that
 * punishes anyone adding an unrelated method. What is not allowed is declaring something
 * the contract does not have, or declaring it differently.
 *
 * What this does NOT cover, stated so nobody reads more assurance into it than it gives:
 *
 * - **Function input names.** Compared by type only, deliberately. See `sameParams`.
 * - **The `parseAbiItem` event fragments** in `lib/useBetHistory.ts` and
 *   `lib/admin/useRelayerHealth.ts`. They are the live history decode path and they are
 *   just as hand-written as these, but they are module-private and `useBetHistory.ts` is
 *   being rewritten by #51, so exporting them for this belongs in a follow-up rather
 *   than in a collision.
 * - **Artifact freshness.** This reads whatever `hardhat compile` last produced. A tree
 *   built from different source passes wrongly. CI compiles in its `build` step before
 *   reaching this test, so the case is a stale local checkout, not a stale CI run.
 */

/** Where `hardhat compile` leaves its output. Gitignored, so it may be absent locally. */
const ARTIFACTS = join(__dirname, "..", "..", "contracts", "artifacts", "contracts");

type AbiParam = {
  readonly name?: string;
  readonly type: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiParam[];
};

type AbiEntry = {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
};

/**
 * Locate `<contract>.json` under the artifacts tree.
 *
 * Hardhat mirrors the source layout, and `contracts/` already has `governance/`,
 * `interfaces/`, `mocks/` and `testnet/` subdirectories, so the path is searched rather
 * than assumed. Guessing one would report "run the build" at a tree that had been built,
 * which is the least useful thing a failing guard can say.
 */
function findArtifact(contract: string, dir = ARTIFACTS): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findArtifact(contract, path);
      if (found) return found;
    } else if (entry.name === `${contract}.json`) {
      return path;
    }
  }
  return undefined;
}

function artifactAbi(contract: string): readonly AbiEntry[] {
  const path = findArtifact(contract);
  // A silent skip would make this guard worthless exactly when it is load bearing, so an
  // uncompiled tree is a failure with instructions rather than a green run.
  assert.ok(
    path,
    `No compiled artifact for ${contract} under ${ARTIFACTS}. Run ` +
      `\`npm run build --workspace @rushood/contracts\` first; CI compiles before it ` +
      `reaches this test.`,
  );
  const abi = JSON.parse(readFileSync(path, "utf8")).abi;
  // Without this, a malformed artifact fails as `onChain.filter is not a function` rather
  // than as the instructive message the check above exists to give.
  assert.ok(Array.isArray(abi), `${path} has no abi array; the artifact is malformed.`);
  return abi;
}

/**
 * Params compared by position and type, plus `indexed`, plus names where a name is load
 * bearing at decode time.
 *
 * **Function inputs: types only.** Calldata is encoded positionally, so an input name is
 * documentation. `RUSH_ABI` calls ERC20's second `approve` argument `amount` where
 * OpenZeppelin calls it `value`, and every call either one produces is byte-identical.
 * Failing on that would make this guard cry wolf about a synonym.
 *
 * **Function outputs: names too.** `toBetView` reads the `bets()` field names straight out
 * of this ABI to build a named bet, so a name that disagrees with the contract silently
 * relabels a field - the same failure as a reorder, reached by a different route.
 *
 * **Event inputs: names too.** viem hands back `log.args` as an *object*, and
 * `useBetHistory` reads `args.stake`, `args.win`, `args.payout` and the rest by name. An
 * event argument is not documentation; it is the key the app reads.
 *
 * `indexed` is compared everywhere it appears, because it decides whether a value arrives
 * in a topic or in the data blob. Flip it on one side and every argument of that event
 * decodes out of the wrong place, without throwing. That is this bug class exactly, and an
 * earlier revision of this file missed it.
 */
function sameParams(
  a: readonly AbiParam[] = [],
  b: readonly AbiParam[] = [],
  { compareNames }: { compareNames: boolean },
): boolean {
  return (
    a.length === b.length &&
    a.every((param, index) => {
      const other = b[index];
      if (param.type !== other.type) return false;
      // Undeclared on one side is a "do not care"; a disagreement is not.
      if (param.indexed !== undefined && other.indexed !== undefined) {
        if (param.indexed !== other.indexed) return false;
      }
      // An unnamed param in the hand-written copy is a deliberate "do not care" - several
      // single-output getters are written that way. A *differing* name is not.
      if (compareNames && param.name && other.name && param.name !== other.name) return false;
      return sameParams(param.components, other.components, { compareNames });
    })
  );
}

function describeParam(param: AbiParam): string {
  const indexed = param.indexed ? "indexed " : "";
  return `${param.type} ${indexed}${param.name ?? ""}`.trim();
}

function describeEntry(entry: AbiEntry): string {
  const params = (entry.inputs ?? []).map(describeParam).join(", ");
  const returns = (entry.outputs ?? []).map(describeParam).join(", ");
  return `${entry.type} ${entry.name ?? ""}(${params})${returns ? ` returns (${returns})` : ""}`;
}

/**
 * Every entry the frontend declares must exist on the contract, identically.
 *
 * Matching is by type and name only, then the shapes are asserted, so an overload that
 * differs in arity reports as a shape mismatch rather than silently matching a sibling.
 * None of these contracts overloads anything today.
 */
function assertMatchesContract(label: string, hand: readonly AbiEntry[], contract: string) {
  const onChain = artifactAbi(contract);

  for (const declared of hand) {
    const candidates = onChain.filter(
      (entry) => entry.type === declared.type && entry.name === declared.name,
    );

    assert.ok(
      candidates.length > 0,
      `${label} declares \`${describeEntry(declared)}\`, which ${contract} does not have. ` +
        `Either the contract changed and this ABI did not, or the name is a typo - and ` +
        `viem will encode a call no deployment can answer.`,
    );

    // Event arguments arrive as a named object, so their names are read; function
    // arguments are encoded positionally, so theirs are not. See `sameParams`.
    const namedInputs = declared.type === "event";

    const matched = candidates.find(
      (entry) =>
        sameParams(entry.inputs, declared.inputs, { compareNames: namedInputs }) &&
        sameParams(entry.outputs, declared.outputs, { compareNames: true }),
    );

    assert.ok(
      matched,
      `${label} and ${contract} disagree about \`${declared.name}\`.\n` +
        `  hand-written: ${describeEntry(declared)}\n` +
        `  on-chain:     ${candidates.map(describeEntry).join("\n                ")}\n` +
        `Field order and names are load bearing: viem decodes positionally, so a mismatch ` +
        `reads every field out of its neighbour's slot without throwing.`,
    );

    if (declared.stateMutability && matched.stateMutability) {
      assert.equal(
        matched.stateMutability,
        declared.stateMutability,
        `${label} declares \`${declared.name}\` as ${declared.stateMutability}, but ` +
          `${contract} declares it ${matched.stateMutability}.`,
      );
    }
  }
}

describe("hand-written ABIs match the compiled contracts", () => {
  it("GAME_ABI matches RushoodGame", () => {
    assertMatchesContract("GAME_ABI", GAME_ABI as readonly AbiEntry[], "RushoodGame");
  });

  it("RUSH_ABI matches Rushood", () => {
    assertMatchesContract("RUSH_ABI", RUSH_ABI as readonly AbiEntry[], "Rushood");
  });

  /**
   * The reorder case, stated on its own because it is the one that has actually bitten
   * this repo, twice, and because the assertion above would report it as a generic shape
   * mismatch buried among the other entries.
   */
  it("declares bets() in exactly the contract's field order", () => {
    const onChain = artifactAbi("RushoodGame").find((entry) => entry.name === "bets");
    const declared = (GAME_ABI as readonly AbiEntry[]).find((entry) => entry.name === "bets");
    assert.ok(onChain, "RushoodGame has no bets() getter");
    assert.ok(declared, "GAME_ABI has no bets() entry");

    assert.deepEqual(
      (declared.outputs ?? []).map((o) => `${o.name}: ${o.type}`),
      (onChain.outputs ?? []).map((o) => `${o.name}: ${o.type}`),
      "bets() is destructured positionally across the frontend and the relayer. Reordering " +
        "the struct without reordering this decodes every field into its neighbour.",
    );
  });
});
