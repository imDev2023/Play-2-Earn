/**
 * Is the relayer actually connected, or only still running? (#39)
 *
 * `game.on(BetPlaced, ...)` has no failure surface. When the underlying transport drops,
 * the callback simply stops being called: nothing throws, the process stays up, and the
 * event loop stays busy. Process liveness and settlement liveness are therefore
 * different questions, and every naive healthcheck answers the wrong one.
 *
 * So liveness is derived from the chain instead, from two facts that a dead connection
 * cannot fake:
 *
 *   1. a cheap read against the node still succeeds, and
 *   2. the head block is still advancing.
 *
 * Deriving it from settlements instead would be the obvious shortcut and is a trap: on
 * a night with no bets there is nothing to settle, so a healthy idle relayer and a dead
 * one produce identical evidence. Block height advances either way.
 */

export interface LivenessInputs {
  now: number;
  /** When a read against the node last succeeded. */
  lastProbeOkAt: number;
  /** When the head block number was last observed to increase. */
  lastBlockAdvanceAt: number;
  /** How long a probe may fail before the node counts as unreachable. */
  probeTimeoutMs: number;
  /** How long the head may sit still before the chain counts as stalled. */
  blockStallMs: number;
}

/**
 * `rpc-down` and `chain-stalled` are separated because they need different responses.
 * An unreachable node is ours to fix - restart, failover, check the URL. A reachable
 * node whose head is frozen is the chain's problem, and restarting into it repeatedly
 * only adds noise to the incident.
 */
export type Liveness = "alive" | "rpc-down" | "chain-stalled";

export function livenessState(inputs: LivenessInputs): Liveness {
  const { now, lastProbeOkAt, lastBlockAdvanceAt, probeTimeoutMs, blockStallMs } = inputs;

  // Reachability is checked first: a node we cannot reach also cannot report a new
  // block, so the stall would be a symptom and reporting it would name the wrong fault.
  if (now - lastProbeOkAt > probeTimeoutMs) return "rpc-down";
  if (now - lastBlockAdvanceAt > blockStallMs) return "chain-stalled";
  return "alive";
}
