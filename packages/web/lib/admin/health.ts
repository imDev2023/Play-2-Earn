/**
 * Relayer health, derived from chain state alone.
 *
 * The operator's real question is not "is a process running" but "are players' bets
 * being settled". Both are answered by the same on-chain fact — how long the active
 * bet has sat unsettled — and that fact needs no service to stay alive, no port, and no
 * CORS story: it reads identically on a local node, on testnet, and on mainnet.
 *
 * The scale that matters is `RushoodGame.SETTLE_TIMEOUT`: past it, players can take
 * their stake back, which is the point at which a stalled relayer becomes visible to
 * everyone rather than just the console.
 */

/**
 * How long an unsettled bet may sit before the console calls it a problem.
 *
 * A healthy relayer settles within a block or two of `BetPlaced`, so a full minute
 * unsettled already means something is wrong — while still leaving 59 minutes of the
 * settle timeout to notice and act before any player is stranded.
 */
export const LAG_WARNING_SECONDS = 60n;

export type RelayerStatus =
  /** No bet in flight — nothing for the relayer to do. */
  | "idle"
  /** A bet is in flight and still inside the healthy window. */
  | "settling"
  /** Unsettled past the warning window: the relayer is behind or down. */
  | "lagging"
  /** Past `SETTLE_TIMEOUT`: the player can now refund the stake. */
  | "stalled"
  /** The chain has not answered yet — not the same as healthy. */
  | "unknown";

export interface RelayerHealthInputs {
  /** `RushoodGame.activeBetId()` — zero when no bet is in flight. */
  activeBetId: bigint;
  /** `placedAt` of the active bet; undefined until the record loads. */
  placedAt?: bigint;
  /** Current time, in unix seconds. */
  now: bigint;
  /** `RushoodGame.SETTLE_TIMEOUT`. */
  settleTimeout: bigint;
  /** How long the most recently settled bet took, when it could be measured. */
  lastSettleLag?: bigint;
}

export interface RelayerHealth {
  status: RelayerStatus;
  /** True only for `idle` and `settling` — "unknown" is not healthy. */
  healthy: boolean;
  /** How long the active bet has been waiting, floored at zero. */
  pendingSeconds: bigint;
  /** Seconds until the active bet becomes refundable; zero once it already is. */
  refundableIn: bigint;
  lastSettleLag?: bigint;
  /** One line an operator can read without decoding the status enum. */
  detail: string;
}

export function relayerHealth(inputs: RelayerHealthInputs): RelayerHealth {
  const { activeBetId, placedAt, now, settleTimeout, lastSettleLag } = inputs;

  if (activeBetId === 0n) {
    return {
      status: "idle",
      healthy: true,
      pendingSeconds: 0n,
      refundableIn: 0n,
      lastSettleLag,
      detail: "No bet in flight.",
    };
  }

  if (placedAt === undefined) {
    return {
      status: "unknown",
      healthy: false,
      pendingSeconds: 0n,
      refundableIn: 0n,
      lastSettleLag,
      detail: `Bet #${activeBetId} is in flight; its record has not loaded yet.`,
    };
  }

  // Block timestamps and the browser clock drift apart, and a Hardhat node's clock can
  // be moved outright. Clamp rather than render a negative age.
  const pendingSeconds = now > placedAt ? now - placedAt : 0n;
  const refundableIn = pendingSeconds >= settleTimeout ? 0n : settleTimeout - pendingSeconds;

  const status: RelayerStatus =
    pendingSeconds >= settleTimeout
      ? "stalled"
      : pendingSeconds >= LAG_WARNING_SECONDS
        ? "lagging"
        : "settling";

  return {
    status,
    healthy: status === "settling",
    pendingSeconds,
    refundableIn,
    lastSettleLag,
    detail: detailFor(status, activeBetId, pendingSeconds, refundableIn),
  };
}

function detailFor(
  status: RelayerStatus,
  betId: bigint,
  pending: bigint,
  refundableIn: bigint,
): string {
  if (status === "stalled") {
    return `Bet #${betId} has been unsettled for ${pending}s — past the settle timeout, so the player can refund it. The relayer is down.`;
  }
  if (status === "lagging") {
    return `Bet #${betId} has been unsettled for ${pending}s. Refundable in ${refundableIn}s.`;
  }
  return `Bet #${betId} placed ${pending}s ago, awaiting settlement.`;
}
