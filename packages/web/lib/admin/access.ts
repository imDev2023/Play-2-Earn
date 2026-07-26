import type { Address } from "viem";

/**
 * Who may drive the admin console, and by which route.
 *
 * "Gated to the multisig" describes a finished deployment, but a real one passes
 * through more than one shape. Straight out of `deploy-skeleton` the deployer key holds
 * `governance` and `guardian` itself; after the #22 handoff policy lives behind the
 * Timelock (proposed and executed by the Safe) while the pause stays with the Safe
 * directly. The console reads the live roles and reports which shape it is looking at,
 * rather than assuming the finished one and offering buttons the chain would reject.
 *
 * The account this compares against is whatever the wallet presents. Connected through
 * Safe{Wallet}'s WalletConnect that IS the Safe, so a signature here becomes a Safe
 * proposal for the other owners to co-sign, and the roles below match. A Safe *owner*
 * connecting their personal key holds none of these roles and is correctly refused —
 * proposing on the Safe's behalf from an owner key would need the Safe Transaction
 * Service, which is a separate integration and not part of #25.
 */

export type AdminRole = "governance" | "guardian" | "proposer" | "executor" | "canceller";

/**
 * How parameter changes reach the game.
 *
 * - `timelock` — governance is a TimelockController: changes are queued and wait out
 *   its delay. The production shape.
 * - `direct` — governance is the connected account: changes land immediately. The
 *   pre-handoff shape; the console says so loudly.
 * - `foreign` — governance is some other account entirely. Nothing to do here.
 * - `unknown` — the roles have not been read yet (or the node is unreachable).
 */
export type GovernanceMode = "timelock" | "direct" | "foreign" | "unknown";

export interface AccessInputs {
  /** The connected wallet, if any. */
  account?: Address;
  /** `RushoodGame.governance()` — the policy role. */
  governance?: Address;
  /** `RushoodGame.guardian()` — the emergency pause role. */
  guardian?: Address;
  /**
   * The governance holder, once confirmed to be a TimelockController (the console
   * probes `getMinDelay()` on it rather than trusting a configured address).
   */
  timelock?: Address;
  /** Whether `account` holds the timelock's PROPOSER_ROLE. */
  isProposer?: boolean;
  /** Whether `account` holds the timelock's EXECUTOR_ROLE. */
  isExecutor?: boolean;
  /** Whether `account` holds the timelock's CANCELLER_ROLE. */
  isCanceller?: boolean;
}

export interface OperatorAccess {
  /** True when the account holds at least one role the console can act with. */
  authorized: boolean;
  /** Every role the account holds, in a stable order. */
  roles: AdminRole[];
  mode: GovernanceMode;
  /** May queue a parameter change on the timelock. */
  canQueue: boolean;
  /** May execute a queued operation once its delay has elapsed. */
  canExecuteQueued: boolean;
  /**
   * May cancel a queued operation. The way out of a mistake: an operation queued with
   * the wrong value is otherwise just sat there waiting for someone to execute it.
   */
  canCancel: boolean;
  /** May call the game's setters directly (only before the timelock handoff). */
  canChangeParamsDirectly: boolean;
  /** May pause/unpause. Independent of who governs. */
  canPause: boolean;
}

/** Case-insensitive address comparison — chains and wallets disagree about casing. */
function sameAddress(a?: string, b?: string): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function operatorAccess(inputs: AccessInputs): OperatorAccess {
  const { account, governance, guardian, timelock, isProposer, isExecutor, isCanceller } = inputs;

  // The timelock only matters when it is the thing that actually governs: a deployed
  // timelock that does not hold the role would happily queue a call the game rejects.
  const governedByTimelock = sameAddress(governance, timelock);
  const mode: GovernanceMode = governance
    ? governedByTimelock
      ? "timelock"
      : sameAddress(governance, account)
        ? "direct"
        : "foreign"
    : "unknown";

  const roles: AdminRole[] = [];
  if (sameAddress(account, governance)) roles.push("governance");
  if (sameAddress(account, guardian)) roles.push("guardian");
  if (account && isProposer) roles.push("proposer");
  if (account && isExecutor) roles.push("executor");
  if (account && isCanceller) roles.push("canceller");

  return {
    authorized: roles.length > 0,
    roles,
    mode,
    canQueue: mode === "timelock" && Boolean(isProposer),
    canExecuteQueued: mode === "timelock" && Boolean(isExecutor),
    canCancel: mode === "timelock" && Boolean(isCanceller),
    canChangeParamsDirectly: mode === "direct",
    canPause: sameAddress(account, guardian),
  };
}
