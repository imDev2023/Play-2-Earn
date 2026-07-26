import { defineChain } from "viem";
import { hardhat } from "wagmi/chains";
import type { Address } from "viem";

/**
 * Chain definitions and player-onboarding helpers.
 *
 * RUSHOOD's home is Robinhood Chain (mainnet 4663; testnet 46630). Local
 * development runs against a Hardhat node (31337); `ACTIVE_CHAIN_ID` selects which
 * chain the app expects a wallet to be on, defaulting to Hardhat so the local play
 * flow works out of the box. All endpoints are env-overridable.
 *
 * Testnet endpoints are the real ones (docs.robinhood.com/chain).
 *
 * Mainnet endpoints are NOT hard-coded, and that is deliberate (#26). Robinhood
 * Chain's mainnet RPC, explorer and bridge URLs are not published yet, so any literal
 * here would be a guess. A guessed RPC is worse than a missing one: the app would look
 * configured, point at a hostname nobody controls, and fail at request time with a
 * network error rather than a diagnosable one. Instead mainnet reads entirely from
 * NEXT_PUBLIC_ROBINHOOD_* env vars, and `activeChainConfigError` reports it plainly
 * when the app is pointed at 4663 without them.
 */

const MAINNET_RPC_URL = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "";
const MAINNET_EXPLORER_URL = process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "";
const MAINNET_BRIDGE_URL = process.env.NEXT_PUBLIC_GAS_BRIDGE_URL ?? "";

/** True once real mainnet endpoints have been supplied. False in every build today. */
export const MAINNET_ENDPOINTS_CONFIGURED = MAINNET_RPC_URL !== "" && MAINNET_EXPLORER_URL !== "";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [MAINNET_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: MAINNET_EXPLORER_URL,
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ??
          "https://rpc.testnet.chain.robinhood.com/rpc",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Testnet Explorer",
      url:
        process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER_URL ??
        "https://explorer.testnet.chain.robinhood.com",
    },
  },
});

/** Every chain the app knows how to talk to. */
export const CHAINS = [hardhat, robinhoodChain, robinhoodTestnet] as const;

/** The chain a wallet must be on to play. Defaults to Hardhat for local dev. */
export const ACTIVE_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? hardhat.id);

/** The active chain's full definition (falls back to Hardhat if the id is unknown). */
export const activeChain = CHAINS.find((c) => c.id === ACTIVE_CHAIN_ID) ?? hardhat;

/** True when the app is targeting a local dev node rather than a public chain. */
export const isLocalChain = activeChain.id === hardhat.id;

/**
 * Where a player without gas is sent. On a real chain this is a bridge/faucet;
 * locally there's nothing to bridge, so callers hide the prompt (see isLocalChain).
 *
 * Returns null when there is nowhere real to send them — mainnet without a configured
 * bridge URL. Callers hide the link rather than offering one that goes nowhere: a dead
 * "Get ETH for gas" link is worse than no link, because a player who clicks it
 * concludes the app is broken rather than that they need to bridge some other way.
 */
export function gasHelpUrl(chainId: number = ACTIVE_CHAIN_ID): string | null {
  if (chainId === robinhoodTestnet.id) {
    return (
      process.env.NEXT_PUBLIC_GAS_FAUCET_URL ??
      "https://faucet.testnet.chain.robinhood.com/add-chain"
    );
  }
  if (chainId === robinhoodChain.id) {
    return MAINNET_BRIDGE_URL === "" ? null : MAINNET_BRIDGE_URL;
  }
  return null;
}

/**
 * Why the active chain can't be talked to, or null when it's fine.
 *
 * Surfaced in the UI so a misconfigured mainnet build says what's wrong instead of
 * failing as an opaque network error on the first RPC call.
 */
export function activeChainConfigError(chainId: number = ACTIVE_CHAIN_ID): string | null {
  if (chainId === robinhoodChain.id && !MAINNET_ENDPOINTS_CONFIGURED) {
    return (
      "Robinhood Chain mainnet endpoints are not configured. Set " +
      "NEXT_PUBLIC_ROBINHOOD_RPC_URL and NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL " +
      "before targeting chain 4663."
    );
  }
  return null;
}

/**
 * A Uniswap swap deep-link that pre-selects RUSH as the token to buy on the active
 * chain. A link (not an embedded widget) keeps the app dependency-light and works
 * even before a RUSH pool exists on a given chain.
 */
export function uniswapSwapUrl(rush: Address, chainId: number = ACTIVE_CHAIN_ID): string {
  const base = process.env.NEXT_PUBLIC_UNISWAP_URL ?? "https://app.uniswap.org/swap";
  const params = new URLSearchParams({ outputCurrency: rush, chain: String(chainId) });
  return `${base}?${params.toString()}`;
}

/** Short, human label for a chain id (for status chips). */
export function chainLabel(chainId: number): string {
  return CHAINS.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`;
}
