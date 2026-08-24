/**
 * The relayer's committed network book (#61).
 *
 * An entry exists here if and only if a deployment record exists under
 * `docs/deployments/`. That is the whole membership rule: `localhost` is deliberately
 * absent (a local run supplies explicit vars, and its addresses change with every
 * deploy), and mainnet is absent because no mainnet deployment exists.
 *
 * `RELAYER_NETWORK=<name>` selects an entry in `loadRelayerConfig`, supplying the
 * RPC URL and game address so neither is typed by hand at run time; the explicit
 * `RELAYER_RPC_URL` / `RELAYER_GAME_ADDRESS` variables still win where set, because
 * an operator overriding a value by hand mid-incident should not be silently
 * ignored. Secrets never live here.
 *
 * `chainId` is what the service verifies on boot: with a committed RPC URL in play,
 * "which chain actually answered" is no longer implied by the operator having typed
 * an endpoint, so the service asserts it (see `assertExpectedChain`). This is the
 * same lesson as the localhost chain-id guard in `hardhat.config.ts`, arriving at
 * the one client that builds its own provider.
 *
 * `test/RelayerService.ts` compares the testnet entry against
 * `docs/deployments/robinhoodTestnet.md`, so this table cannot silently drift from
 * the published record.
 */
export interface RelayerNetwork {
  chainId: number;
  rpcUrl: string;
  gameAddress: string;
}

export const RELAYER_NETWORKS: Record<string, RelayerNetwork> = {
  // Robinhood Chain testnet, the 2026-08-13 redeploy
  // (docs/deployments/robinhoodTestnet.md).
  robinhoodTestnet: {
    chainId: 46630,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com/rpc",
    gameAddress: "0x84DD77034E1eDFEf6A26a5aAbb0036FA1F4b56aA",
  },
};

/** The names an operator can put in RELAYER_NETWORK, for error messages. */
export function knownNetworkNames(): string {
  return Object.keys(RELAYER_NETWORKS).join(", ");
}
