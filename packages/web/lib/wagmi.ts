import { http, createConfig } from "wagmi";
import { hardhat } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";
import { isLocalChain, robinhoodChain, robinhoodTestnet } from "./chain";

/**
 * wagmi config. Knows three chains: the local Hardhat node for development, plus
 * Robinhood Chain and its testnet for real play. `ACTIVE_CHAIN_ID` (see lib/chain)
 * selects which one the app expects a wallet to be on.
 *
 * Connectors:
 *   - `injected` - the fallback for a wallet that does not announce itself over
 *     EIP-6963. Wallets that do announce are added by wagmi automatically, so the
 *     list this produces is longer than what it declares. `lib/connectors` picks the
 *     one the UI offers.
 *   - `mock` - a Hardhat dev account (#1, unlocked on the node), so the local play
 *     flow works without a browser wallet and stays testable end-to-end.
 *
 * The mock is registered only when the app is pointed at a local node. It signs as a
 * key from a published test mnemonic, so on any real chain it is not a convenience
 * but a "Connect Mock Connector" button offered to players, next to the real one.
 * Gating it here rather than hiding it in the UI means a production bundle has no
 * such connector to reach for at all.
 */
const DEV_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat account #1

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

export const wagmiConfig = createConfig({
  chains: [hardhat, robinhoodChain, robinhoodTestnet],
  connectors: isLocalChain
    ? [injected(), mock({ accounts: [DEV_ACCOUNT], features: {} })]
    : [injected()],
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
