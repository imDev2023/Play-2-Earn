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
 * Returns null when there is nowhere real to send them - mainnet without a configured
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

/**
 * Chains RUSHOOD does not run on, but that players arrive from.
 *
 * The wrong-network banner reads "You're on {label}", and the label has one job: to
 * match what the player can see in their own wallet, so the two screens agree about
 * where they are. "Chain 1" fails that against a MetaMask reading "Ethereum".
 *
 * Deliberately short. This is not a chain registry - it covers the networks a wallet
 * is plausibly sitting on when it lands here, and anything else still degrades to the
 * id, which is at least unambiguous.
 */
const VISITING_CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  11155111: "Sepolia",
};

/**
 * Is a connected wallet somewhere it cannot play?
 *
 * Shared rather than written out at each call site because two places depend on it -
 * the banner that offers the switch, and the bet button that has to be disabled while
 * it is showing. If those two ever disagreed the result is the failure this replaced:
 * a live-looking bet button on the wrong chain.
 *
 * `undefined` is not a wrong network. It is the gap before the connection reports a
 * chain, and treating it as wrong would flash "Switch network to play" at players who
 * are on exactly the right one.
 *
 * Narrowing to `number` follows from that: a caller inside the wrong-network branch is
 * holding a chain id the wallet has actually reported, and can name it without a
 * fallback for a case this function has already excluded.
 */
export function isWrongNetwork(chainId: number | undefined): chainId is number {
  return chainId !== undefined && chainId !== ACTIVE_CHAIN_ID;
}

/** Short, human label for a chain id (for status chips). */
export function chainLabel(chainId: number): string {
  return (
    CHAINS.find((c) => c.id === chainId)?.name ??
    VISITING_CHAIN_NAMES[chainId] ??
    `Chain ${chainId}`
  );
}
