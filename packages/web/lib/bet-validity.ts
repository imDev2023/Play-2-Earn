import { formatUnits } from "viem";

/**
 * Why a bet cannot be placed, decided before the wallet is ever asked.
 *
 * This exists because `placeBet` asks for a spending approval first. A stake the
 * player cannot cover therefore costs them a wallet prompt - one their wallet flags in
 * red, since the approval is unlimited - followed by a transaction that reverts inside
 * an ERC-20 transfer, and the error that comes back names `transferFrom` rather than
 * their balance. Every reason below is knowable from state already on screen, so none
 * of them should ever reach the chain.
 *
 * Kept as a pure function of four values so the thresholds can be argued with in a
 * test rather than discovered by a player.
 */
export type BetBlock = "below-min" | "above-max" | "below-min-balance" | "unaffordable" | null;

export interface BetInputs {
  /** Parsed stake in wei, or null when the field is empty or unparseable. */
  stake: bigint | null;
  minBet?: bigint;
  maxBet?: bigint;
  balance?: bigint;
}

/**
 * The first reason this bet cannot go through, or null.
 *
 * Order matters: the contract's own bounds are reported before affordability, because
 * a stake outside them is wrong regardless of what the player holds, and telling
 * someone to buy more tokens for a bet the game would reject anyway is worse than
 * saying nothing.
 */
export function betBlock({ stake, minBet, maxBet, balance }: BetInputs): BetBlock {
  if (stake === null) return null;
  if (minBet !== undefined && stake < minBet) return "below-min";
  if (maxBet !== undefined && stake > maxBet) return "above-max";
  if (balance === undefined) return null;
  if (stake > balance) {
    // Distinguished because the advice differs. Below the minimum bet there is no
    // smaller stake to fall back to, so "lower the stake" would be a dead end.
    return minBet !== undefined && balance < minBet ? "below-min-balance" : "unaffordable";
  }
  return null;
}

/** What to tell the player, in terms of the thing they can change. */
export function betBlockMessage(block: BetBlock, balance?: bigint): string | null {
  switch (block) {
    case "below-min":
      return "Stake is below the minimum bet.";
    case "above-max":
      return "Stake exceeds the max for this tier.";
    case "below-min-balance":
      return `You hold ${formatUnits(balance ?? 0n, 18)} RUSH, less than the minimum bet.`;
    case "unaffordable":
      return `You hold ${formatUnits(balance ?? 0n, 18)} RUSH. Lower the stake or get more.`;
    default:
      return null;
  }
}
