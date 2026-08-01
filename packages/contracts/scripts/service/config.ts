import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress } from "ethers";
import { DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "../lib/hashchain";

/**
 * Production configuration for the relayer service (#39).
 *
 * Everything the service needs is named explicitly and validated before it does any
 * work. The dev script reads its game address out of `deployments/<network>.json`, a
 * gitignored build artefact that is not present in a container, and picks its signer by
 * index out of whatever Hardhat happens to expose. Neither is a thing to be holding a
 * mainnet key by.
 *
 * Validation is deliberately all-at-once and fail-fast. A service that dies on boot
 * with a complete list of what is wrong costs one restart; one that reports the first
 * problem only, on a host where a retry means rebuilding a container, costs an evening.
 */

/** Fully resolved, validated runtime configuration. Construct only via `loadRelayerConfig`. */
export interface RelayerConfig {
  rpcUrl: string;
  gameAddress: string;
  privateKey: string;
  masterSeed: string;
  chainLength: number;
  rotationMargin: number;
  /** Healthchecks.io ping URL for the dead man's switch. Absent disables it. */
  healthcheckPingUrl?: string;
  /**
   * Healthchecks.io ping URL for explicit alerts. A *different* check from the dead
   * man's switch: see `HealthchecksHeartbeat` for why sharing one silently swallows
   * every page the relayer raises.
   */
  alertUrl?: string;
  /** Balance below which funding is a warning, and below which it pages. */
  ethWarnWei: bigint;
  ethPageWei: bigint;
  /**
   * How often the main loop runs. This is both the settle poll and the liveness probe:
   * the loop reads the head and the active bet on every pass, so a successful pass is
   * itself the evidence that the connection is alive.
   */
  pollIntervalMs: number;
  /** How long polls may fail before the node counts as unreachable. */
  probeTimeoutMs: number;
  /** How long the head may sit still before the chain counts as stalled. */
  blockStallMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * A positive whole number.
 *
 * Integer rather than merely finite because every one of these counts something
 * discrete - reveals in a chain, milliseconds on a clock. A fractional chain length
 * would silently disagree with the loop bound that builds the chain, so the configured
 * length and the real one would differ by a rounding rule nobody wrote down.
 */
function optionalNumber(env: Env, key: string, fallback: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    problems.push(`${key} must be a positive whole number (got ${JSON.stringify(raw)})`);
    return fallback;
  }
  return value;
}

function optionalWei(env: Env, key: string, fallback: bigint, problems: string[]): bigint {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    problems.push(`${key} must be a non-negative integer in wei (got ${JSON.stringify(raw)})`);
    return fallback;
  }
}

/** The credential name the systemd unit loads the seed under. */
export const SEED_CREDENTIAL_NAME = "relayer-seed";

/**
 * Take the seed from a systemd credential when it is not already in the environment.
 *
 * `systemd-creds` is the custody mechanism the runbook recommends, because it keeps the
 * seed encrypted at rest and out of `systemctl show`. systemd hands it to the process
 * as a file under `$CREDENTIALS_DIRECTORY` rather than as an environment variable, so
 * without this the recommended path would produce a service that refuses to boot,
 * naming a variable the operator had deliberately not set.
 *
 * The environment still wins where both are present: an operator overriding the seed by
 * hand, mid-incident, should not be silently ignored in favour of a file.
 *
 * The reader is injectable so the tests do not need a filesystem.
 */
export function withCredentialSeed(
  env: Env,
  readCredential: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Env {
  if (env.RELAYER_SEED?.trim()) return env;
  const directory = env.CREDENTIALS_DIRECTORY;
  if (!directory) return env;
  try {
    return { ...env, RELAYER_SEED: readCredential(join(directory, SEED_CREDENTIAL_NAME)) };
  } catch {
    // Deliberately silent. The boot failure that follows names RELAYER_SEED, which is
    // the actionable message; a read error on a path the operator may never have
    // configured would only bury it.
    return env;
  }
}

/**
 * Read and validate the environment.
 *
 * Throws with every problem listed. The message deliberately never echoes the value of
 * a secret: an invalid key or seed is reported by name only, because boot errors are
 * exactly the thing that ends up pasted into a chat window or a log aggregator.
 */
export function loadRelayerConfig(env: Env): RelayerConfig {
  const problems: string[] = [];

  const rpcUrl = env.RELAYER_RPC_URL?.trim();
  if (!rpcUrl) problems.push("RELAYER_RPC_URL is required (the chain's JSON-RPC endpoint)");

  const gameAddress = env.RELAYER_GAME_ADDRESS?.trim();
  if (!gameAddress) {
    problems.push("RELAYER_GAME_ADDRESS is required (the deployed RushoodGame)");
  } else if (!isAddress(gameAddress)) {
    problems.push("RELAYER_GAME_ADDRESS is not a valid address");
  }

  const privateKey = env.RELAYER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    problems.push("RELAYER_PRIVATE_KEY is required (the account that sponsors settlement gas)");
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    problems.push("RELAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }

  // Trimmed like every other value here. A seed arriving from a `.env` file or a
  // secrets manager routinely carries a trailing newline, and an untrimmed one would
  // slip past the dev-seed check below by a single invisible character - defeating the
  // one guard that stands between a public seed and a real deployment.
  const masterSeed = env.RELAYER_SEED?.trim();
  if (!masterSeed) {
    problems.push("RELAYER_SEED is required and has no default in production");
  } else if (masterSeed === DEFAULT_MASTER_SEED) {
    // Not merely a weak secret: it is committed in this repository, so anyone can
    // rebuild the whole reveal chain and know every future roll before it is placed.
    problems.push(
      "RELAYER_SEED is the committed dev seed, which is public. Generate a secret seed for this deployment.",
    );
  }

  const chainLength = optionalNumber(env, "RELAYER_CHAIN_LENGTH", DEFAULT_CHAIN_LENGTH, problems);
  const rotationMargin = optionalNumber(env, "RELAYER_ROTATION_MARGIN", 4, problems);
  if (rotationMargin >= chainLength) {
    problems.push("RELAYER_ROTATION_MARGIN must be smaller than RELAYER_CHAIN_LENGTH");
  }

  // Defaults sized for an L2 where a settle costs cents: warn with roughly a thousand
  // settlements left, page with roughly a hundred. Both are overridable because gas is
  // the one thing here that is not ours to predict.
  const ethWarnWei = optionalWei(env, "RELAYER_ETH_WARN_WEI", 10n ** 16n, problems);
  const ethPageWei = optionalWei(env, "RELAYER_ETH_PAGE_WEI", 10n ** 15n, problems);
  if (ethPageWei > ethWarnWei) {
    problems.push("RELAYER_ETH_PAGE_WEI must not exceed RELAYER_ETH_WARN_WEI");
  }

  // 3s keeps settlement inside the "a block or two" window that `relayerHealth` treats
  // as healthy on an L2 with roughly one-second blocks.
  const healthcheckPingUrl = env.RELAYER_HEALTHCHECK_URL?.trim() || undefined;
  const alertUrl = env.RELAYER_ALERT_URL?.trim() || undefined;
  // The single most damaging way to misconfigure this. The heartbeat pings the check up
  // once per pass; pointed at the alert check, it would cancel any page within one poll
  // interval, and the Alerter's dedupe would stop it ever being re-delivered. The result
  // looks healthier than having no alerting at all, which is what makes it worth a boot
  // failure rather than a warning.
  if (healthcheckPingUrl && alertUrl && healthcheckPingUrl === alertUrl) {
    problems.push(
      "RELAYER_HEALTHCHECK_URL and RELAYER_ALERT_URL must be two different Healthchecks.io checks. " +
        "Sharing one means the liveness ping cancels every alert the relayer raises.",
    );
  }

  const pollIntervalMs = optionalNumber(env, "RELAYER_POLL_INTERVAL_MS", 3_000, problems);
  const probeTimeoutMs = optionalNumber(env, "RELAYER_PROBE_TIMEOUT_MS", 60_000, problems);
  const blockStallMs = optionalNumber(env, "RELAYER_BLOCK_STALL_MS", 120_000, problems);

  if (problems.length > 0) {
    throw new Error(`Relayer configuration is incomplete:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    rpcUrl: rpcUrl as string,
    gameAddress: gameAddress as string,
    privateKey: privateKey as string,
    masterSeed: masterSeed as string,
    chainLength,
    rotationMargin,
    healthcheckPingUrl,
    alertUrl,
    ethWarnWei,
    ethPageWei,
    pollIntervalMs,
    probeTimeoutMs,
    blockStallMs,
  };
}

/**
 * One line describing how the service is configured, safe to log on boot.
 *
 * Neither the seed nor the key appears. The address the key controls does, because an
 * operator's first question after a funding alert is which account to top up.
 */
export function describeConfig(config: RelayerConfig, relayerAddress: string): string {
  return [
    `game ${config.gameAddress}`,
    `relayer ${relayerAddress}`,
    `chain length ${config.chainLength} (rotate at ${config.chainLength - config.rotationMargin})`,
    config.healthcheckPingUrl ? "dead man's switch on" : "dead man's switch OFF",
    config.alertUrl ? "alerts on" : "alerts to the journal only",
  ].join(", ");
}
