import { http, createConfig } from "wagmi";
import { hardhat } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";

/**
 * Local-dev wagmi config for the walking skeleton.
 *
 * Two connectors:
 *   - `injected` — a real browser wallet (e.g. MetaMask) pointed at the local node.
 *   - `mock` — a Hardhat dev account (account #1, unlocked on the node), so the app
 *     can place real bets locally without a browser wallet. The node signs for its
 *     own unlocked accounts, which also keeps the connect->bet flow testable.
 *
 * Later tickets swap `hardhat` for Robinhood testnet/mainnet and drop the mock.
 */
const DEV_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat account #1

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

export const wagmiConfig = createConfig({
  chains: [hardhat],
  connectors: [
    injected(),
    mock({ accounts: [DEV_ACCOUNT], features: {} }),
  ],
  transports: {
    [hardhat.id]: http(rpcUrl),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
