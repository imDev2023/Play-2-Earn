import type { Address } from "viem";
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
    outputs: [
      { name: "player", type: "address" },
      { name: "tier", type: "uint8" },
      { name: "stake", type: "uint256" },
      { name: "clientSeed", type: "uint256" },
      { name: "placedAt", type: "uint256" },
      { name: "settled", type: "bool" },
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
    outputs: [{ type: "uint256" }],
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
 * One bet, by name.
 *
 * `bets()` is a Solidity struct getter, so viem hands back a positional array and every
 * caller destructures it by position. That is this repo's sharpest edge: reorder the
 * struct and each field decodes into its neighbour without throwing, because an address
 * is still an address and a uint is still a uint. Two consumers nearly shipped that way
 * in #48 and both were caught by review rather than by a test.
 *
 * Naming the fields once, here, means a reorder is a one-line change in a single place
 * instead of a hunt through five call sites. It does not make a reorder *safe* on its
 * own - `stake`, `clientSeed` and `placedAt` are all bigint, so swapping them still
 * type-checks - which is why `test/contracts.test.ts` pins the ABI's declared order and
 * widths alongside it.
 *
 * The existing positional call sites are deliberately left alone: `bets()` is being
 * repacked in #48 and rewriting them here would collide with a change already in review.
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

type RawBet = readonly [
  Address,
  number,
  bigint,
  bigint,
  bigint,
  boolean,
  `0x${string}`,
  `0x${string}`,
];

export function toBetView(raw: RawBet): BetView {
  const [player, tier, stake, clientSeed, placedAt, settled, commit, reveal] = raw;
  return { player, tier, stake, clientSeed, placedAt, settled, commit, reveal };
}
