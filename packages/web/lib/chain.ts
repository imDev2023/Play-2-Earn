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
 * Testnet endpoints are the real ones (docs.robinhood.com/chain). Uniswap v3 is
 * deployed on Robinhood Chain — revisit the Buy-RUSH link target in #26 to point
 * at that deployment (see developers.uniswap.org v3 robinhood-chain deployments).
 */

// TODO(#26): mainnet RPC/explorer are still placeholders — the real Robinhood
// Chain mainnet endpoints aren't published yet (docs.robinhood.com/chain). Fill
// these in (or set the NEXT_PUBLIC_ROBINHOOD_* env vars) before any mainnet cutover.
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.chain.robinhood.com/rpc"],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "https://explorer.chain.robinhood.com",
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
 */
export function gasHelpUrl(chainId: number = ACTIVE_CHAIN_ID): string {
  if (chainId === robinhoodTestnet.id) {
    return (
      process.env.NEXT_PUBLIC_GAS_FAUCET_URL ??
      "https://faucet.testnet.chain.robinhood.com/add-chain"
    );
  }
  // TODO(#26): real mainnet bridge URL not published yet — placeholder for now.
  return process.env.NEXT_PUBLIC_GAS_BRIDGE_URL ?? "https://bridge.chain.robinhood.com";
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
