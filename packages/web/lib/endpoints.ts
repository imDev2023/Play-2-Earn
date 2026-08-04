/**
 * Every network endpoint the app is configured with, read from the environment in one
 * place.
 *
 * These were read inline wherever they were needed - `chain.ts` for the viem chain
 * definitions, `wagmi.ts` for the local transport. That was fine while the only
 * consumer was a chain definition, and stopped being fine once the Content-Security
 * Policy had to name them: a `connect-src` assembled from a second, hand-copied list of
 * env vars is a policy that silently stops matching the app the first time one of them
 * changes, and the failure mode is the app being unable to reach its own chain.
 *
 * So the names live here, once, and everything else imports them. Deliberately free of
 * viem and wagmi imports, because `middleware.ts` builds the CSP from this and should
 * not pull a chain library into the edge bundle to do it.
 */

/** The local dev node. */
export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * Robinhood Chain mainnet. Empty until supplied - see the note in chain.ts about why
 * these are not hard-coded.
 */
export const MAINNET_RPC_URL = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "";
export const MAINNET_EXPLORER_URL = process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "";
export const MAINNET_BRIDGE_URL = process.env.NEXT_PUBLIC_GAS_BRIDGE_URL ?? "";

/** Robinhood Chain testnet. The defaults are the real published endpoints. */
export const TESTNET_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ??
  "https://rpc.testnet.chain.robinhood.com/rpc";
export const TESTNET_EXPLORER_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER_URL ??
  "https://explorer.testnet.chain.robinhood.com";

/**
 * Every URL the browser makes a *request* to, as opposed to links it navigates away to.
 *
 * This is the CSP's `connect-src` list. Explorer, faucet and Uniswap URLs are
 * deliberately absent: those are anchors the player follows, and a navigation is not a
 * fetch, so allowing them to be connected to would widen the policy for nothing.
 */
export function rpcEndpoints(): string[] {
  return [LOCAL_RPC_URL, MAINNET_RPC_URL, TESTNET_RPC_URL].filter((url) => url !== "");
}
