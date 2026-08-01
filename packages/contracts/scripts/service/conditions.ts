import { formatEther } from "ethers";
import type { RelayerHealth } from "@rushood/verifier";
import type { Alert } from "./alerts";
import type { Liveness } from "./liveness";

/**
 * The conditions the relayer alerts on (#39).
 *
 * Each is a pure function from an observation to an alert or nothing, so the thresholds
 * can be argued with in a test rather than discovered during an incident.
 *
 * None of these can lose player money. `refund()` after `SETTLE_TIMEOUT` covers every
 * one of them, which is what #19 is for. What they lose is the game being playable, and
 * because the game settles one bet at a time, "a bet is stuck" and "the game is down"
 * are the same sentence. That is why lag pages rather than warns.
 */

/**
 * Settlement lag, read from the same state machine the admin console uses.
 *
 * The thresholds are not restated here. `relayerHealth` owns them, so the console and
 * the pager cannot drift into disagreeing about whether the game is healthy.
 */
export function settlementLagAlert(health: RelayerHealth): Alert | null {
  if (health.status === "lagging") {
    return {
      key: "settlement-lag",
      severity: "page",
      summary: "Relayer is behind: a bet is unsettled past the healthy window.",
      detail: health.detail,
    };
  }
  if (health.status === "stalled") {
    // A separate key, so this escalation is delivered rather than deduped against the
    // lag alert that preceded it. By now the player can already refund.
    return {
      key: "settlement-stalled",
      severity: "page",
      summary: "Relayer is down: a bet is past the settle timeout and refundable.",
      detail: health.detail,
    };
  }
  return null;
}

/**
 * Relayer gas balance.
 *
 * The relayer sponsors every settlement, so an empty balance stops the game exactly the
 * way a crash does, and produces the same silent refund path. Warning well ahead of the
 * paging floor is the point: topping up is trivial, noticing is not.
 */
export function fundingAlert(balanceWei: bigint, warnWei: bigint, pageWei: bigint): Alert | null {
  if (balanceWei < pageWei) {
    return {
      key: "relayer-funding",
      severity: "page",
      summary: `Relayer is nearly out of gas: ${formatEther(balanceWei)} ETH.`,
      detail: "Settlements stop when this reaches zero, and every bet then times out into a refund.",
    };
  }
  if (balanceWei < warnWei) {
    return {
      key: "relayer-funding",
      severity: "warn",
      summary: `Relayer gas is low: ${formatEther(balanceWei)} ETH.`,
      detail: "Top up before it reaches the paging floor.",
    };
  }
  return null;
}

/**
 * Reveal chain nearing exhaustion.
 *
 * The least recoverable of these conditions. Rotation is only legal between bets, so the
 * window to act closes the moment the next bet arrives; and past the end of the chain
 * there is no reveal left to publish at all, so the active bet cannot be settled by
 * anyone and can only be refunded.
 *
 * It fires when rotation is *overdue*, not when it becomes due. The relayer rotates
 * itself at `chainLength - margin`, so alerting there would page on every healthy
 * rotation, and a pager that fires on routine behaviour is one nobody reads. Climbing
 * past that point is the real signal: it means rotation was due and did not happen,
 * either because the relayer is down or because bets are arriving continuously and it
 * never gets the between-bets window rotation requires.
 */
export function chainExhaustionAlert(
  round: number,
  chainLength: number,
  margin: number,
): Alert | null {
  const rotateAt = chainLength - margin;
  if (round <= rotateAt) return null;
  return {
    key: "chain-exhaustion",
    severity: "page",
    summary: `Reveal chain is at round ${round} of ${chainLength} and needs rotating.`,
    detail:
      "Rotation is only possible between bets. Past the end of the chain the active bet " +
      "cannot be settled at all and can only be refunded.",
  };
}

/**
 * Connection liveness.
 *
 * This is the condition that catches the failure the others cannot see: a dropped
 * subscription settles nothing while nothing errors, so lag only fires if a player
 * happens to bet, and a process-level healthcheck reports green throughout.
 */
export function livenessAlert(state: Liveness): Alert | null {
  if (state === "rpc-down") {
    return {
      key: "rpc-down",
      severity: "page",
      summary: "Relayer cannot reach the node.",
      detail: "No bet will be settled until this recovers, whether or not any are being placed.",
    };
  }
  if (state === "chain-stalled") {
    return {
      key: "chain-stalled",
      severity: "page",
      summary: "The node is reachable but its head block is not advancing.",
      detail: "Restarting the relayer will not help; this is upstream of us.",
    };
  }
  return null;
}
