import { http, createConfig } from "wagmi";
import { hardhat } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";
import { robinhoodChain, robinhoodTestnet } from "./chain";

/**
 * wagmi config. Knows three chains: the local Hardhat node for development, plus
 * Robinhood Chain and its testnet for real play. `ACTIVE_CHAIN_ID` (see lib/chain)
 * selects which one the app expects a wallet to be on.
 *
 * Connectors:
 *   - `injected` — a real browser wallet (MetaMask, etc.), used on any chain.
 *   - `mock` — a Hardhat dev account (#1, unlocked on the node), so the local play
 *     flow works without a browser wallet and stays testable end-to-end.
 */
const DEV_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat account #1

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

export const wagmiConfig = createConfig({
  chains: [hardhat, robinhoodChain, robinhoodTestnet],
  connectors: [injected(), mock({ accounts: [DEV_ACCOUNT], features: {} })],
  transports: {
    [hardhat.id]: http(rpcUrl),
    [robinhoodChain.id]: http(),
    [robinhoodTestnet.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
