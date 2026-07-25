import { verifyQueryParams, type VerifyInputs } from "@rushood/verifier";
import type { BetEntry } from "./useBetHistory";

/**
 * Links into the public `/verify` tool.
 *
 * A verify link carries every input in the URL, so it verifies for anyone who opens it
 * — no wallet, no lookup, no trusting this app's RPC. The query is built by
 * `@rushood/verifier`, the same module that parses it, so a link the app produces is
 * guaranteed to be readable by the `/verify` page and by the CLI
 * (`npm run verify -- --url "…"`).
 */

/**
 * The verifier inputs for a bet, or null when the chain hasn't supplied enough of them
 * yet — a freshly-placed bet before its record has been read back, or one still
 * awaiting the reveal.
 *
 * The rename across this boundary is deliberate: the contract's storage names are
 * `clientSeed`/`commit`, while the spec and the verifier speak of `clientEntropy` and
 * `commitment`. This is the one place the two vocabularies meet.
 */
export function verifyInputsFor(bet: BetEntry): VerifyInputs | null {
  if (bet.clientSeed === undefined || bet.commit === undefined || bet.reveal === undefined) {
    return null;
  }
  return {
    betId: bet.betId,
    tier: bet.tier,
    clientEntropy: bet.clientSeed,
    commitment: bet.commit,
    serverReveal: bet.reveal,
    reported: {
      ...(bet.outcome === "pending" ? {} : { win: bet.outcome === "won" }),
      ...(bet.roll === undefined ? {} : { roll: bet.roll }),
    },
  };
}

/** A self-contained `/verify` URL. Relative, so it works on any host. */
export function verifyHref(inputs: VerifyInputs): string {
  return `/verify?${verifyQueryParams(inputs).toString()}`;
}

/** Treat the zero word as "absent" — an unconsumed reveal slot reads as 0x00…0. */
export function isZeroHex(value: string): boolean {
  return /^0x0*$/.test(value);
}

/** Middle-truncate a long hex value for display, keeping both ends checkable. */
export function shortHex(value: string): string {
  return value.length <= 21 ? value : `${value.slice(0, 10)}…${value.slice(-10)}`;
}
