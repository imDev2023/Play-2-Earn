import { defineChain } from "viem";
import { hardhat } from "wagmi/chains";
import type { Address } from "viem";

/**
 * Chain definitions and player-onboarding helpers.
 *
 * RUSHOOD's home is Robinhood Chain (mainnet 4663; testnet 46630). RPC/explorer
 * URLs are env-overridable placeholders until the real endpoints land with the
 * testnet/mainnet deploy (#26). Local development runs against a Hardhat node
 * (31337); `ACTIVE_CHAIN_ID` selects which chain the app expects a wallet to be
 * on, defaulting to Hardhat so the local play flow works out of the box.
 */

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.robinhoodchain.org"],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "https://explorer.robinhoodchain.org",
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ?? "https://testnet-rpc.robinhoodchain.org",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Testnet Explorer",
      url:
        process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER_URL ??
        "https://testnet-explorer.robinhoodchain.org",
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
 */
export function gasHelpUrl(chainId: number = ACTIVE_CHAIN_ID): string {
  if (chainId === robinhoodTestnet.id) {
    return process.env.NEXT_PUBLIC_GAS_FAUCET_URL ?? "https://faucet.robinhoodchain.org";
  }
  return process.env.NEXT_PUBLIC_GAS_BRIDGE_URL ?? "https://bridge.robinhoodchain.org";
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
