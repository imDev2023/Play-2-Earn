/**
 * Wallet and RPC errors arrive as multi-paragraph dumps - the revert, the request body,
 * the docs link, the version banner. The first line is the part a person needs; the
 * rest belongs in the console, not in the UI.
 */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim();
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

  if (/user rejected|user denied|rejected the request/i.test(message)) return null;

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
