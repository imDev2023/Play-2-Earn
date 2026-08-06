/**
 * Wallet and RPC errors arrive as multi-paragraph dumps - the revert, the request body,
 * the docs link, the version banner. The first line is the part a person needs; the
 * rest belongs in the console, not in the UI.
 */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim();
}

/** EIP-1193: the request was rejected by the user. */
const USER_REJECTED_REQUEST = 4001;

/**
 * Did the person decline the prompt?
 *
 * Asked of the numeric code rather than the wording, because the wording is whatever
 * the wallet's language happens to be: a Spanish MetaMask says "El usuario rechazo la
 * solicitud", and matching English phrases would show that person an error for a
 * decision they made deliberately. The code is the part of EIP-1193 that does not
 * change between locales or wallets.
 *
 * Walks `cause`, since viem and wagmi wrap the provider's error rather than replacing
 * it, so the code sits a layer or two down.
 */
function isUserRejection(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (code === USER_REJECTED_REQUEST || code === String(USER_REJECTED_REQUEST)) return true;
  return isUserRejection(cause, depth + 1);
}

/**
 * Did the person decline, by code or - for a wallet that drops the code - by wording?
 *
 * Both callers below ask exactly this, and they must keep agreeing: one decides whether
 * a failed switch is worth reporting, the other whether a failed bet is coloured as a
 * fault. If the two drifted apart, the same declined prompt would be silent on one
 * screen and an error on the other.
 */
function declined(error: unknown, message: string): boolean {
  return isUserRejection(error) || /user rejected|user denied|rejected the request/i.test(message);
}

/** What to tell the player after a bet attempt did not go through. */
export type BetFailure = {
  message: string;
  /** A declined prompt is a decision, not a fault, and must not be coloured like one. */
  tone: "error" | "neutral";
};

/**
 * Why a bet did not happen, in words the player has a use for.
 *
 * Declining the wallet prompt is the case worth separating. It is not a failure at all
 * - it is the player deciding not to spend - and the raw wording that reaches the UI
 * ("User rejected the request.") is written from the wallet's point of view, names the
 * player in the third person, and arrives in the same red as a genuine fault. Someone
 * who deliberately backed out is told they did something wrong.
 *
 * Detected by the EIP-1193 code rather than the wording, for the reason
 * `isUserRejection` documents: the wording is whatever the wallet's language happens to
 * be, and matching English phrases would show a Spanish speaker a fault for a decision
 * they made on purpose. The regex is a fallback for wallets that drop the code.
 *
 * Everything else keeps its message. A revert or an RPC failure is something the player
 * needs, and inventing friendlier copy for it would hide the part that identifies it.
 */
export function betFailure(error: unknown): BetFailure {
  const message = readableError(error);

  if (declined(error, message)) {
    return { message: "You declined the prompt, so no bet was placed.", tone: "neutral" };
  }

  return { message, tone: "error" };
}

/**
 * Why a network switch failed, in words that say what to do next.
 *
 * Switching is the one place the app asks the wallet to change its own configuration,
 * so it fails for reasons that are about the wallet rather than about us, and the raw
 * message is written for whoever implemented the wallet. Two cases are worth naming
 * because they are the ones people actually hit:
 *
 * A wallet that already has a *different* network saved against the same RPC URL will
 * refuse to add ours, and says so in terms of the chain it already knows. On a local
 * node this is close to guaranteed: every Hardhat and Anvil preset ships pointing at
 * `127.0.0.1:8545`, so anyone who has done Ethereum development before already has one.
 * The wallet gives no way for a site to resolve this, which makes saying plainly what
 * to remove the entire fix available to us.
 *
 * A rejected prompt is not a failure at all, and should not be dressed up as one.
 */
export function switchFailureMessage(error: unknown): string | null {
  const message = readableError(error);

  if (declined(error, message)) return null;

  if (/same rpc (endpoint|url)/i.test(message)) {
    return (
      "Your wallet already has a different network saved against this RPC URL, so it will " +
      "not add this one. Remove or re-point that network in your wallet's network list, " +
      "then switch again."
    );
  }

  if (/unrecognized chain id/i.test(message)) {
    return "Your wallet does not know this network yet. Approve the add-network prompt to continue.";
  }

  return message;
}
