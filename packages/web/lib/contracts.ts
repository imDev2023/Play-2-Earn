import type { Address, ReadContractReturnType } from "viem";
import { TIER_ODDS } from "@rushood/verifier";

/**
 * Contract addresses for the walking skeleton.
 *
 * Defaults are the deterministic addresses from `deploy-skeleton.ts` on a fresh
 * local Hardhat node (deployer nonces 0/1/2). Override per environment with
 * NEXT_PUBLIC_* vars once real deployments exist.
 */
export const GAME_ADDRESS = (process.env.NEXT_PUBLIC_GAME_ADDRESS ??
  "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0") as Address;

export const RUSH_ADDRESS = (process.env.NEXT_PUBLIC_RUSH_ADDRESS ??
  "0x5FbDB2315678afecb367f032d93F642f64180aa3") as Address;

/**
 * Payout numerator/denominator and the tier multiplier label both come from the public
 * verifier, so the play UI and the `/verify` page can never quote different payouts -
 * they read the same table the fairness check does.
 */
export { EDGE_NUM, EDGE_DEN, multiplierLabel } from "@rushood/verifier";

/**
 * The six odds tiers, mirroring RushoodGame.odds(). Tier N is a 1-in-N shot paying
 * a flat 0.95 x N (5% house edge). Index === on-chain tier id. Only the display label
 * lives here; the odds and multiplier come from the verifier's table.
 */
const TIER_LABELS = ["Coin flip", "1-in-4", "1-in-10", "1-in-50", "1-in-100", "Moonshot"];

export const TIERS = TIER_ODDS.map((odds, index) => ({
  odds: Number(odds),
  label: TIER_LABELS[index],
}));

/** Minimal ABI for the pieces of RushoodGame the skeleton UI touches. */
export const GAME_ABI = [
  {
    type: "function",
    name: "minBet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxBet",
    stateMutability: "view",
    inputs: [{ name: "tier", type: "uint8" }],
    outputs: [{ type: "uint256" }],
  },
  {
    // Public getter for the `bets` mapping - the authoritative record for a bet, read
    // by the history so it never depends on catching the BetPlaced event. Since #24 it
    // also carries `commit` and `reveal`, so one call yields the complete set of
    // inputs a fairness check needs.
    type: "function",
    name: "bets",
    stateMutability: "view",
    inputs: [{ name: "betId", type: "uint256" }],
    // Order and widths follow the struct's storage layout, which was packed for gas
    // in #47 - `settled` and `placedAt` moved up to share a slot with `player` and
    // `tier`. Callers destructure this tuple positionally, so the order here is load
    // bearing: get it wrong and the fields decode into each other silently.
    outputs: [
      { name: "player", type: "address" },
      { name: "tier", type: "uint8" },
      { name: "settled", type: "bool" },
      { name: "placedAt", type: "uint64" },
      { name: "stake", type: "uint256" },
      { name: "clientSeed", type: "uint256" },
      { name: "commit", type: "bytes32" },
      { name: "reveal", type: "bytes32" },
    ],
  },
  {
    // The standing head of the server hash chain: what the *next* bet will be locked
    // against. Shown before a bet so a player can record the commitment themselves.
    type: "function",
    name: "currentCommit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "placeBet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tier", type: "uint8" },
      { name: "stake", type: "uint256" },
      { name: "clientSeed", type: "uint256" },
    ],
    outputs: [{ name: "betId", type: "uint256" }],
  },
  {
    // The player's way out of a settlement that never came. Callable by anyone once
    // SETTLE_TIMEOUT has elapsed, and it works while paused, so an incident cannot
    // strand a stake. It was missing from this ABI entirely, which meant the guarantee
    // existed on-chain and nowhere a player could reach it.
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [],
  },
  // --- The admin/treasury console's read surface (#25) -----------------------------
  // Roles, live economics and the solvency numbers an operator needs to see before
  // touching anything. All plain views; the console never infers a param it can read.
  {
    type: "function",
    name: "governance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "guardian",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "treasuryBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "treasuryFloor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxPayout",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "burnRateBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "edgeNum",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "edgeDen",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "solvencyCapDen",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activeBetId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function",
    name: "SETTLE_TIMEOUT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_BURN_RATE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "economicsGovernable",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },

  // --- Guardian (emergency) and governance (policy) calls ---------------------------
  // The setters are here so the console can *encode* them for the timelock queue as
  // well as call them directly pre-handoff - see lib/admin/ops.ts.
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "unpause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "setBurnRate",
    stateMutability: "nonpayable",
    inputs: [{ name: "newBps", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setEconomicsGovernable",
    stateMutability: "nonpayable",
    inputs: [{ name: "enabled", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setMinBet",
    stateMutability: "nonpayable",
    inputs: [{ name: "newMinBet", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setEdge",
    stateMutability: "nonpayable",
    inputs: [
      { name: "num", type: "uint256" },
      { name: "den", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setSolvencyCap",
    stateMutability: "nonpayable",
    inputs: [{ name: "den", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTreasuryFloor",
    stateMutability: "nonpayable",
    inputs: [{ name: "newFloor", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "burnTreasuryProfit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "BetPlaced",
    inputs: [
      { name: "betId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "tier", type: "uint8", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
      { name: "clientSeed", type: "uint256", indexed: false },
      { name: "commit", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BetSettled",
    inputs: [
      { name: "betId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "win", type: "bool", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
      { name: "reveal", type: "bytes32", indexed: false },
      { name: "roll", type: "uint256", indexed: false },
    ],
  },
  {
    // A refunded bet never settles, so it never emits BetSettled. Without this the play
    // screen would keep drawing after the stake had already been returned.
    type: "event",
    name: "BetRefunded",
    inputs: [
      { name: "betId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Minimal ERC20 ABI for reading balances and approving the game as spender. */
export const RUSH_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * One bet, by name - zipped against the ABI's own declared output names.
 *
 * `bets()` is a Solidity struct getter, so viem hands back a positional array, and this
 * repo's sharpest edge is that reordering the struct decodes every field into its
 * neighbour without throwing: an address is still an address and a uint is still a uint.
 * Two consumers nearly shipped that way in #48 and review, not tests, caught both.
 *
 * The first attempt here destructured by position like everything else. That was the
 * same bug wearing a helper's clothes: #48 repacks the struct to
 * `player, tier, settled, placedAt, stake, ...`, and because the two changes touch
 * different lines of this file they would have merged clean and left this reading
 * `settled` out of the stake slot - a truthy bigint, so the pending-bet recovery would
 * have bailed on every unsettled bet and the settlement panel would never reappear
 * after a reload.
 *
 * So the mapping is not written down at all. It is read from the `bets()` entry in
 * `GAME_ABI` above, which is the same declaration viem decodes against, so the two
 * cannot disagree about *order*. `BetViewNamesMatchAbi` below extends that to *names*,
 * and `RawBet` derives the argument type from the same entry, so a reorder retypes the
 * call site too rather than silently accepting the old shape.
 *
 * What none of this can check is the hand-written `GAME_ABI` drifting from
 * `RushoodGame.sol` itself. That guard is `packages/web/test/contracts.test.ts`, which
 * arrived with #48.
 *
 * #48 has landed, and its repack proved the point the hard way: the merge collided in
 * `useBetHistory.ts`, where the two hard-coded orders disagreed about every field after
 * `tier`. That site now decodes through `toBetView`. Three positional call sites remain
 * - `VerifyTool.tsx` and `useRelayerHealth.ts` (twice) - and should move onto this too.
 */
export type BetView = {
  player: Address;
  tier: number;
  stake: bigint;
  clientSeed: bigint;
  placedAt: bigint;
  settled: boolean;
  commit: `0x${string}`;
  reveal: `0x${string}`;
};

type BetsAbi = Extract<(typeof GAME_ABI)[number], { name: "bets" }>;

/**
 * The field names `bets()` declares, in the order it returns them.
 *
 * Deliberately not widened to `string[]`: the literal union is what lets the compiler
 * check `BetView` against it below.
 */
export const BETS_FIELDS: readonly BetsAbi["outputs"][number]["name"][] = GAME_ABI.find(
  // Non-null because `GAME_ABI` is `as const` in this file: drop `bets()` from it and
  // `BetsAbi` resolves to `never`, which makes `BetViewNamesMatchAbi` below a compile
  // error. There is no build in which this find returns undefined.
  (entry): entry is BetsAbi => entry.type === "function" && entry.name === "bets",
)!.outputs.map((output) => output.name);

/**
 * `BetView`'s keys and the names `bets()` declares must be the same set, in either
 * direction. Without this, renaming an output in the ABI would leave that field
 * `undefined` on every decoded bet and the cast in `toBetView` would hide it - the same
 * silent-wrong-field failure this whole helper exists to prevent, just by name instead
 * of by position. It costs nothing at runtime; it is a compile error or it is nothing.
 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type BetViewNamesMatchAbi = AssertTrue<
  SameKeys<keyof BetView, BetsAbi["outputs"][number]["name"]>
>;

/**
 * Exactly what `readContract({ functionName: "bets" })` hands back. Derived from the ABI
 * rather than hand-written, so a reorder retypes this instead of leaving a stale tuple
 * that still accepts the new shape.
 */
export type RawBet = ReadContractReturnType<typeof GAME_ABI, "bets">;

export function toBetView(raw: RawBet): BetView {
  return Object.fromEntries(
    BETS_FIELDS.map((field, index) => [field, raw[index]]),
  ) as unknown as BetView;
}
