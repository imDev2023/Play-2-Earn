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
 * Robinhood Chain mainnet. The defaults are the real published endpoints, as the
 * testnet ones below are - see the note in chain.ts for why they were withheld until
 * 2026-07-31 and what changed.
 *
 * The bare host is the form the chain documents and the form every other file in this
 * repo prints (`docs/ops/relayer.md`, `resources/01-robinhood-chain.md`, the 4663
 * profile), so it is the one committed here. The testnet sibling below carries a `/rpc`
 * suffix and keeps it: both forms answer on both networks (checked 2026-08-27), and that
 * value is the one a real settlement has already run through.
 *
 * `docs/spec/RUSHOOD-game-spec.md` §10 plans the production RPC through Alchemy rather
 * than the public endpoint. That is a deployment choice, not a contradiction - it is
 * exactly what `NEXT_PUBLIC_ROBINHOOD_RPC_URL` is for, and a public default is the right
 * thing to commit because it is the one that is true for anyone who has no key.
 *
 * `packages/contracts/hardhat.config.ts` deliberately does NOT follow this and leaves
 * `robinhoodMainnet.url` empty. The asymmetry is the point: a web build that can read
 * 4663 is harmless because `lib/addresses.ts` has no 4663 entry and throws, whereas a
 * contracts package with a working mainnet URL makes `--network robinhoodMainnet` a live
 * deploy target. Do not "fix" that half to match this one.
 */
export const MAINNET_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const MAINNET_EXPLORER_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "https://robinhoodchain.blockscout.com";

/**
 * Still empty, and deliberately so. The chain documents its bridge only as "the
 * canonical Arbitrum bridge" and publishes no single URL, so anything here would be the
 * guess the rest of this block stopped needing to make. `gasHelpUrl` hides the link
 * rather than offering a dead one.
 */
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
 *
 * The list is every chain the app knows, not just the one it is built for, because a
 * wallet can be on any of them and the switch flow has to reach the one it is moving to.
 * Giving mainnet a committed default therefore widened the policy: until then its ""
 * was filtered out here, and a testnet build's `connect-src` named two hosts rather than
 * three. That is worth knowing rather than worth reverting - all three are first-party
 * Robinhood JSON-RPC endpoints that store nothing and read nothing back, so the widening
 * adds no exfiltration channel. Narrowing the list to the active chain would be a real
 * tightening and is a separate change, because it has to keep the switch flow working.
 */
export function rpcEndpoints(): string[] {
  return [LOCAL_RPC_URL, MAINNET_RPC_URL, TESTNET_RPC_URL].filter((url) => url !== "");
}
