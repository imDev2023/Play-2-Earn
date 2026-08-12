/**
 * Where "local" is, and how to be sure you actually got there.
 *
 * Hardhat ships a built-in `localhost` network pointing at `127.0.0.1:8545`, and it
 * applies whenever the config declares no `localhost` entry of its own. That default is
 * the problem: the port is a shared resource on a developer's machine, so `--network
 * localhost` means "whoever answers on 8545", not "this project's node". During the
 * redeploy rehearsal 8545 was held by an unrelated `anvil` forking BNB testnet, and the
 * launch deployment would have gone to it without a word.
 *
 * Two defences, kept separate because they fail in different ways:
 *
 *   `localRpcUrl`        - lets a run move off a busy port, so the collision is avoidable.
 *   `assertLocalDevChain` - refuses to proceed when the thing that answered is not a local
 *                           dev chain, which is what catches the run where nobody knew to
 *                           move ports in the first place.
 *
 * Deliberately free of any Hardhat import: `hardhat.config.ts` consumes this while it is
 * still being evaluated, so anything reachable from here must not reach back.
 */

/** The chain id a Hardhat node reports, and the one `anvil` defaults to. */
export const LOCAL_CHAIN_ID = 31337n;

/** Hardhat's own `node` task listens here, so it stays the default. */
const DEFAULT_LOCAL_PORT = 8545;
const DEFAULT_LOCAL_HOST = "127.0.0.1";

/** The network names that mean "a throwaway chain on this machine". */
const LOCAL_NETWORK_NAMES = ["localhost", "hardhat"];

type Env = Record<string, string | undefined>;

export function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORK_NAMES.includes(networkName);
}

/**
 * The URL the `localhost` network points at.
 *
 * `LOCAL_RPC_URL` wins outright, for a node that is not on this host at all. Otherwise
 * `LOCAL_RPC_PORT` moves the port while keeping the loopback host.
 *
 * A malformed port throws rather than falling back. Falling back would hand the default
 * port to whoever set the variable *because* the default port was taken - reintroducing
 * this module's entire reason for existing, at the one moment someone was actively trying
 * to avoid it.
 */
export function localRpcUrl(env: Env = process.env): string {
  const url = env.LOCAL_RPC_URL;
  if (url !== undefined && url !== "") return url;

  const rawPort = env.LOCAL_RPC_PORT;
  if (rawPort === undefined) return `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_PORT}`;

  // `Number` accepts whitespace and empty strings; neither is a port.
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `LOCAL_RPC_PORT must be a port between 1 and 65535, got ${JSON.stringify(rawPort)}`,
    );
  }
  return `http://${DEFAULT_LOCAL_HOST}:${port}`;
}

/**
 * Refuse to treat a foreign chain as a local rehearsal.
 *
 * Only ever fires for the local network names. A public network is identified by its own
 * `chainId` in the config, which Hardhat itself checks against the node, so there is
 * nothing to add there - and asserting anything about them here would be a second,
 * quieter source of truth about which chain is which.
 */
export function assertLocalDevChain(networkName: string, chainId: bigint): void {
  if (!isLocalNetwork(networkName)) return;
  if (chainId === LOCAL_CHAIN_ID) return;

  throw new Error(
    `Network "${networkName}" resolved to chain ${chainId}, but a local dev chain reports ` +
      `${LOCAL_CHAIN_ID}. Something else is answering on that RPC endpoint - check what is ` +
      `listening, and set LOCAL_RPC_PORT (or LOCAL_RPC_URL) to reach this project's node.`,
  );
}
