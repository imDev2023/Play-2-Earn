/**
 * @rushood/verifier — the public fairness verifier for RUSHOOD.
 *
 * A RUSHOOD roll is settled by a two-party commit-reveal. Before you bet, the
 * server has already committed to its next reveal on-chain (the head of a reverse
 * hash chain). At bet time you contribute your own entropy, which the server cannot
 * see in advance. At settlement the server publishes the reveal; the contract checks
 * that it really is the pre-image of the standing commitment and derives the draw
 * from both sides' contributions plus the bet id:
 *
 *     commitment == keccak256(serverReveal)                     // the chain link
 *     R          == keccak256(serverReveal, clientEntropy, betId)
 *     roll       == R mod N                                     // N = the tier's odds
 *     win        == roll == 0                                   // a 1-in-N shot
 *
 * Neither side can grind: the server's value is fixed before your entropy exists,
 * and your entropy is fixed before the server's value is public.
 *
 * This module is that formula, and nothing else — no network, no wallet, no state.
 * Everything it needs is public: `betId`, `clientEntropy`, `serverReveal` and the
 * `commitment`, all emitted by `BetPlaced`/`BetSettled` and readable from
 * `RushoodGame.bets(betId)`. It is the single implementation shared by the `/verify`
 * tool, the in-app fairness panel, and the contract test suite that pins it against
 * `RushoodGame.outcomeOf`, so the public verifier and the on-chain check can never
 * drift apart.
 */

import { encodePacked, keccak256 } from "viem";

export type Hex = `0x${string}`;

/** Odds N for each tier index — a 1-in-N shot. Mirrors `RushoodGame.odds()`. */
export const TIER_ODDS = [2n, 4n, 10n, 50n, 100n, 1000n] as const;

/** Payout numerator/denominator: 0.95, a flat 5% house edge on every tier. */
export const EDGE_NUM = 95n;
export const EDGE_DEN = 100n;

/** The public inputs that determine a roll. All four are published on-chain. */
export interface RollInputs {
  /** The bet's id. Mixed into the draw, so an outcome can't be replayed across bets. */
  betId: bigint;
  /** Odds tier index in [0, TIER_ODDS.length). */
  tier: number;
  /** The player's entropy, fixed at bet time before the server's reveal is public. */
  clientEntropy: bigint;
  /** The server's reveal, whose keccak256 must equal the standing commitment. */
  serverReveal: Hex;
}

/** A recomputed draw. */
export interface Roll {
  /** R — the raw 256-bit draw, keccak256(serverReveal, clientEntropy, betId). */
  entropy: bigint;
  /** R reduced to the tier's range. A win is a roll of exactly 0. */
  roll: bigint;
  /** The tier's odds N. */
  odds: bigint;
  /** Whether the draw wins: `roll === 0n`, a 1-in-N event. */
  win: boolean;
}

/** What a verification can find wrong. An empty list is a clean pass. */
export type VerifyFailure =
  | "unknown-tier"
  /** keccak256(serverReveal) is not the commitment — the reveal is not the committed one. */
  | "commitment-mismatch"
  /** The recomputed roll differs from the one the chain reported. */
  | "roll-mismatch"
  /** The recomputed win/loss differs from the one the chain reported. */
  | "win-mismatch";

export interface VerifyInputs extends RollInputs {
  /** The commitment this bet was locked against (`BetPlaced.commit`). */
  commitment: Hex;
  /**
   * What the chain claims happened, cross-checked against the recomputation.
   * Optional: with neither field set, `verifyRoll` still checks the chain link and
   * tells you what the inputs *should* have produced.
   */
  reported?: { win?: boolean; roll?: bigint };
}

export interface Verdict {
  /** True when every check passed. */
  ok: boolean;
  /** Whether the reveal really is the pre-image of the commitment. */
  commitmentValid: boolean;
  /** The draw as recomputed from the inputs. */
  computed: Roll;
  /** Every check that failed, in the order they were run. */
  failures: VerifyFailure[];
}

/** Thrown when a tier index has no entry in the published ladder. */
export class UnknownTierError extends Error {
  constructor(tier: number) {
    super(`unknown tier ${tier} — RUSHOOD publishes tiers 0..${TIER_ODDS.length - 1}`);
    this.name = "UnknownTierError";
  }
}

/** Whether a tier index is one of the published odds tiers. */
export function isKnownTier(tier: number): boolean {
  return Number.isInteger(tier) && tier >= 0 && tier < TIER_ODDS.length;
}

/** The odds N for a tier — a 1-in-N shot. */
export function oddsFor(tier: number): bigint {
  if (!isKnownTier(tier)) throw new UnknownTierError(tier);
  return TIER_ODDS[tier];
}

/** The winning payout for a stake on a tier: `0.95 * N * stake`, floored as on-chain. */
export function payoutFor(tier: number, stake: bigint): bigint {
  return (stake * EDGE_NUM * oddsFor(tier)) / EDGE_DEN;
}

/**
 * Display label for a tier's winning multiplier, e.g. `1.9×` for the coin flip and
 * `950×` for the moonshot.
 *
 * @dev Deliberately float division: `0.95 * N` is fractional on four of the six tiers,
 *      and integer division would render the coin flip as `1×`. This is a *label*; the
 *      money math is `payoutFor`, which floors in the house's favour exactly like the
 *      contract does.
 */
export function multiplierLabel(tier: number): string {
  return `${(Number(EDGE_NUM) * Number(oddsFor(tier))) / Number(EDGE_DEN)}×`;
}

/**
 * The commitment a reveal satisfies: `keccak256(serverReveal)`.
 *
 * This is the hash-chain link. The server publishes `commitment` *before* the bet;
 * a valid reveal is any value that hashes to it, which only the server can know.
 */
export function commitmentFor(serverReveal: Hex): Hex {
  return keccak256(serverReveal);
}

/**
 * Recompute a draw from its public inputs. Pure — the same arithmetic
 * `RushoodGame.outcomeOf` runs on-chain.
 */
export function computeRoll({ betId, tier, clientEntropy, serverReveal }: RollInputs): Roll {
  const odds = oddsFor(tier);
  const entropy = BigInt(
    keccak256(
      encodePacked(["bytes32", "uint256", "uint256"], [serverReveal, clientEntropy, betId]),
    ),
  );
  const roll = entropy % odds;
  return { entropy, roll, odds, win: roll === 0n };
}

/**
 * Verify a settled roll: check the hash-chain link, recompute the draw, and (when
 * given) cross-check it against what the chain reported.
 *
 * Never throws on bad input — an unknown tier is reported as a failure like any
 * other, so a UI can render one verdict shape for every outcome.
 */
export function verifyRoll(inputs: VerifyInputs): Verdict {
  const failures: VerifyFailure[] = [];

  if (!isKnownTier(inputs.tier)) {
    return {
      ok: false,
      commitmentValid: eqHex(commitmentFor(inputs.serverReveal), inputs.commitment),
      computed: { entropy: 0n, roll: 0n, odds: 0n, win: false },
      failures: ["unknown-tier"],
    };
  }

  const commitmentValid = eqHex(commitmentFor(inputs.serverReveal), inputs.commitment);
  if (!commitmentValid) failures.push("commitment-mismatch");

  const computed = computeRoll(inputs);
  if (inputs.reported?.roll !== undefined && inputs.reported.roll !== computed.roll) {
    failures.push("roll-mismatch");
  }
  if (inputs.reported?.win !== undefined && inputs.reported.win !== computed.win) {
    failures.push("win-mismatch");
  }

  return { ok: failures.length === 0, commitmentValid, computed, failures };
}

/**
 * The smallest client entropy (counting from 0) that produces the desired outcome
 * for a given bet. A test/demo helper — a player picks entropy at random, and
 * grinding it buys nothing anyway, because the server's reveal is still secret when
 * the entropy is fixed.
 */
export function seedForOutcome(
  base: Omit<RollInputs, "clientEntropy">,
  wantWin: boolean,
  limit = 1_000_000n,
): bigint {
  for (let clientEntropy = 0n; clientEntropy < limit; clientEntropy++) {
    if (computeRoll({ ...base, clientEntropy }).win === wantWin) return clientEntropy;
  }
  throw new Error(`no client entropy under ${limit} yields win=${wantWin} for this bet`);
}

/** Case-insensitive hex comparison — chains and wallets disagree about casing. */
function eqHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export {
  parseVerifyInputs,
  verifyQueryParams,
  type FieldError,
  type ParseResult,
  type RawVerifyInputs,
} from "./parse";

export {
  LAG_WARNING_SECONDS,
  relayerHealth,
  type RelayerHealth,
  type RelayerHealthInputs,
  type RelayerStatus,
} from "./relayer-health";
