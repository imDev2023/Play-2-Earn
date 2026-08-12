/**
 * Where "local" is.
 *
 * Hardhat ships a built-in `localhost` network pointing at `127.0.0.1:8545`, and it
 * applies whenever the config declares no `localhost` entry of its own. That default is
 * the problem: the port is a shared resource on a developer's machine, so `--network
 * localhost` means "whoever answers on 8545", not "this project's node". During the
 * redeploy rehearsal 8545 was held by an unrelated `anvil` forking BNB testnet, and the
 * launch deployment would have gone to it without a word.
 *
 * The enforcement is not in this file and deliberately so. `hardhat.config.ts` declares
 * `chainId` on the `localhost` entry, which makes Hardhat wrap the provider in its own
 * `ChainIdValidatorProvider` and reject a mismatch on the first request. That covers every
 * task and script, including ones written after this comment and ones nobody thought to
 * edit.
 *
 * An earlier version of this module also exported an `assertLocalDevChain` that each
 * deploy script called at its top. It was removed because it could never run: the
 * `chainId` it took as an argument had to be fetched through the very provider that
 * throws, so the validator fired while the argument was still being evaluated. A guard
 * that cannot execute is worse than no guard, because the next reader trusts it. If a
 * second layer is ever wanted, it has to sit somewhere that does not go through Hardhat's
 * provider at all.
 *
 * What remains here is the escape hatch that makes the enforcement survivable: without a
 * way to move off a busy port, the only remedy for a collision is to stop working.
 *
 * KNOWN LIMIT. A chain id is evidence of which network answered, not of what state it
 * holds. `hardhat node --fork <mainnet>` and `anvil --fork-url <mainnet>` both keep
 * reporting 31337, so a fork passes while carrying foreign balances and contract
 * addresses. The rehearsal collision was caught only because that anvil had adopted its
 * fork's id. Guarding that would mean fingerprinting genesis, which is a different job;
 * what is promised here is that a *different chain* cannot be mistaken for the local one.
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
 * The URL the `localhost` network points at, with `LOCAL_RPC_PORT` moving it off a port
 * something else already holds.
 *
 * The `node` script in package.json reads the same variable through shell `:-`, so the
 * node and the scripts that talk to it move together. Unset and empty are both treated as
 * "not set" here for exactly that reason - `${LOCAL_RPC_PORT:-8545}` cannot distinguish
 * them, and a rule this file enforced alone would put the node on one port and every
 * client on another.
 *
 * A malformed port throws rather than falling back. Falling back would hand the default
 * port to whoever set the variable *because* the default port was taken - reintroducing
 * this module's entire reason for existing, at the one moment someone was actively trying
 * to avoid it.
 */
export function localRpcUrl(env: Env = process.env): string {
  const rawPort = env.LOCAL_RPC_PORT;
  if (rawPort === undefined || rawPort === "") {
    return `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_PORT}`;
  }

  // `Number` accepts whitespace, so match the digits explicitly.
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `LOCAL_RPC_PORT must be a port between 1 and 65535, got ${JSON.stringify(rawPort)}`,
    );
  }
  return `http://${DEFAULT_LOCAL_HOST}:${port}`;
}
