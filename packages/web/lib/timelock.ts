import type { Hex } from "viem";

/**
 * The slice of OpenZeppelin's `TimelockController` the admin console drives, plus the
 * conventions RUSHOOD uses when queueing through it.
 *
 * The console never takes a timelock address from configuration: it reads
 * `RushoodGame.governance()` and probes `getMinDelay()` on whatever answers. A timelock
 * that is deployed but does not hold the governance role can queue operations all day
 * and every one of them will revert on execution, so "is a timelock" is the wrong
 * question — "is the thing that governs, and is a timelock" is the right one.
 */

/** The zero word — an absent predecessor, or a salt the timelock never recorded. */
export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

/** No predecessor: RUSHOOD queues each change independently rather than in chains. */
export const NO_PREDECESSOR = ZERO_BYTES32;

/**
 * `TimelockController.OperationState`. A cancelled operation returns to `Unset`, which
 * is why the console labels 0 as "cancelled" for an id it has seen scheduled.
 */
export const OPERATION_STATE = { Unset: 0, Waiting: 1, Ready: 2, Done: 3 } as const;

export type OperationStatus = "cancelled" | "waiting" | "ready" | "executed";

export function operationStatus(state: number | undefined): OperationStatus | undefined {
  switch (state) {
    case OPERATION_STATE.Unset:
      return "cancelled";
    case OPERATION_STATE.Waiting:
      return "waiting";
    case OPERATION_STATE.Ready:
      return "ready";
    case OPERATION_STATE.Done:
      return "executed";
    default:
      return undefined;
  }
}

/**
 * A fresh 32-byte salt for every queued operation.
 *
 * An operation's id is a hash of (target, value, data, predecessor, salt), and the
 * timelock refuses to schedule an id it has already seen — including one already
 * executed. With a zero salt, setting the burn rate back to a value it once held would
 * be unschedulable forever. A random salt makes each queueing distinct.
 */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const TIMELOCK_ABI = [
  {
    type: "function",
    name: "getMinDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "PROPOSER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "EXECUTOR_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "CANCELLER_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    // The timestamp an operation becomes executable (1 for a done operation, 0 for unset).
    type: "function",
    name: "getTimestamp",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getOperationState",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "payload", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "CallScheduled",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "target", type: "address", indexed: false },
      { name: "value", type: "uint256", indexed: false },
      { name: "data", type: "bytes", indexed: false },
      { name: "predecessor", type: "bytes32", indexed: false },
      { name: "delay", type: "uint256", indexed: false },
    ],
  },
  {
    // Emitted alongside CallScheduled whenever the salt is non-zero. The salt is NOT in
    // CallScheduled, and `execute` needs it, so the console joins the two by id to
    // rebuild an executable operation from logs alone.
    type: "event",
    name: "CallSalt",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const;
