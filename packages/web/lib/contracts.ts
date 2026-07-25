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

/** Minimal ABI for the pieces of RushoodGame the skeleton UI touches. */
export const GAME_ABI = [
  {
    type: "function",
    name: "BET_AMOUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "placeBet",
    stateMutability: "nonpayable",
    inputs: [{ name: "clientSeed", type: "uint256" }],
    outputs: [{ name: "betId", type: "uint256" }],
  },
  {
    type: "event",
    name: "BetPlaced",
    inputs: [
      { name: "betId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
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
