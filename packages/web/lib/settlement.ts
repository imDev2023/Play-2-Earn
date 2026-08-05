/**
 * How a bet that has not settled yet should be described to the player.
 *
 * A settled bet is a moment; an unsettled one is a silence. RUSHOOD's draw is written
 * for the moment - a flickering number and "Verifying the reveal on-chain..." - and
 * that copy is honest for the two seconds a healthy relayer takes. If the relayer is
 * down, the same screen keeps flickering forever, and the player is left watching an
 * animation with their stake locked and nothing on screen admitting anything is wrong.
 *
 * That is the worst possible moment to say nothing, because it is the moment the
 * player's trust is actually being tested. The contract already has the answer:
 * `refund(betId)` returns the stake to the player once `SETTLE_TIMEOUT` has elapsed, and
 * it is callable by anyone, works while paused, and cannot be refused. None of that was
 * reachable, or even mentioned, from the play screen.
 *
 * So the drawing state escalates with time rather than looping:
 *
 *   drawing   - normal. The relayer is expected to settle within seconds.
 *   slow      - past the point where a healthy relayer would have settled. Explain what
 *               is being waited on and that the stake is recoverable, with a countdown.
 *   refundable - `SETTLE_TIMEOUT` has elapsed. Offer the refund.
 *
 * The thresholds are deliberately not a guess about the relayer's speed. `SETTLE_TIMEOUT`
 * is read from the contract, so the countdown is the real deadline rather than a
 * hard-coded hour that would drift if governance ever changed it.
 */

/** How long a settle may take before the UI stops implying everything is fine. */
export const SLOW_SETTLE_MS = 20_000;

export type SettlementPhase = "drawing" | "slow" | "refundable";

export interface SettlementState {
  phase: SettlementPhase;
  /** Seconds until the refund unlocks; 0 once it has. */
  refundableIn: number;
}

/**
 * Where a pending bet stands, from times the chain already agrees on.
 *
 * `placedAt` and `now` are both chain seconds. Using the browser clock for `now` would
 * make the countdown disagree with the contract that enforces it, and a refund button
 * that appears a minute before `refund` will accept the call is worse than one that
 * appears a minute late.
 */
export function settlementState({
  placedAt,
  now,
  settleTimeout,
}: {
  placedAt: number;
  now: number;
  settleTimeout: number;
}): SettlementState {
  const elapsed = Math.max(0, now - placedAt);
  const refundableIn = Math.max(0, settleTimeout - elapsed);

  if (refundableIn === 0) return { phase: "refundable", refundableIn: 0 };
  if (elapsed * 1000 >= SLOW_SETTLE_MS) return { phase: "slow", refundableIn };
  return { phase: "drawing", refundableIn };
}

/**
 * A countdown in the largest unit that still reads precisely.
 *
 * Minutes for anything over a minute, because "in 58 minutes" is what a person plans
 * around and "in 3,491 seconds" is not.
 */
export function countdownLabel(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
