import type { Address } from "viem";

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

/** Payout numerator/denominator, mirroring RushoodGame's EDGE_NUM/EDGE_DEN. */
export const EDGE_NUM = 95;
export const EDGE_DEN = 100;

/** Display label for a tier's winning multiplier, derived from odds (0.95 × N). */
export function multiplierLabel(odds: number): string {
  return `${(EDGE_NUM * odds) / EDGE_DEN}×`;
}

/**
 * The six odds tiers, mirroring RushoodGame.odds(). Tier N is a 1-in-N shot paying
 * a flat 0.95 x N (5% house edge). Index === on-chain tier id. The multiplier is
 * derived from `odds` (see multiplierLabel) rather than duplicated as a literal.
 */
export const TIERS = [
  { odds: 2, label: "Coin flip" },
  { odds: 4, label: "1-in-4" },
  { odds: 10, label: "1-in-10" },
  { odds: 50, label: "1-in-50" },
  { odds: 100, label: "1-in-100" },
  { odds: 1000, label: "Moonshot" },
] as const;

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
    // Public getter for the `bets` mapping — the authoritative tier/stake for a bet,
    // read by the history so it never depends on catching the BetPlaced event.
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
    ],
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
    type: "event",
    name: "BetPlaced",
    inputs: [
      { name: "betId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "tier", type: "uint8", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
      { name: "clientSeed", type: "uint256", indexed: false },
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
