import { JsonRpcProvider, Wallet } from "ethers";
import { roundForHead } from "./lib/relayer-core";
import {
  Alerter,
  ConsoleSink,
  HealthchecksHeartbeat,
  HealthchecksSink,
  SilentHeartbeat,
} from "./service/alerts";
import {
  assertExpectedChain,
  describeConfig,
  loadRelayerConfig,
  withCredentialSeed,
} from "./service/config";
import { connectGame } from "./service/game";
import { resolveEpoch, runPass, type LoopState } from "./service/loop";

/**
 * The production relayer (#39).
 *
 * Deliberately free of Hardhat. `scripts/relayer.ts` is a Hardhat script: it needs the
 * runtime environment, the compiled artifacts and a network config to exist, reads its
 * game address out of a gitignored build artefact, and picks its signer by index from
 * whatever accounts happen to be exposed. That is fine for a local node and is not a
 * thing to hold a mainnet key by. This entrypoint takes a URL, a key and an address,
 * and nothing else - which is also what lets it run in a container that carries no
 * toolchain.
 *
 * Run it with:
 *   npx tsx scripts/relayer-service.ts
 *
 * Every knob is an environment variable; see `service/config.ts` and docs/ops/relayer.md.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadRelayerConfig(withCredentialSeed(process.env));

  const provider = new JsonRpcProvider(config.rpcUrl);

  // The first thing asked of the endpoint, before any read the service would act on:
  // which chain is this? A committed RELAYER_NETWORK carries the expected id, and a
  // wrong answer is a boot failure - the one moment a wrong chain costs a restart
  // rather than a key signing against the wrong deployment.
  assertExpectedChain(config, Number((await provider.getNetwork()).chainId));

  const wallet = new Wallet(config.privateKey, provider);
  const game = connectGame(config.gameAddress, wallet);

  // Two destinations, deliberately. The heartbeat's meaning comes from stopping, the
  // alert's from arriving; pointed at one check the first would cancel the second.
  const sink = config.alertUrl ? new HealthchecksSink(config.alertUrl) : new ConsoleSink();
  const heartbeat = config.healthcheckPingUrl
    ? new HealthchecksHeartbeat(config.healthcheckPingUrl)
    : new SilentHeartbeat();
  const alerter = new Alerter(sink);

  // Boot fails loudly rather than degrading. A relayer that cannot read the chain, or
  // whose seed does not match the deployment, settles nothing; starting anyway would
  // produce a process that looks healthy to a supervisor while the game is down.
  const head = await game.currentCommit();
  const { epoch, chain } = resolveEpoch(config.masterSeed, head, config.chainLength);
  const settleTimeout = await game.SETTLE_TIMEOUT();

  console.log(`Relayer starting: ${describeConfig(config, wallet.address)}`);
  console.log(`Epoch ${epoch}, round ${roundForHead(chain, head)} of ${config.chainLength}.`);
  if (!config.healthcheckPingUrl) {
    console.warn(
      "RELAYER_HEALTHCHECK_URL is unset: the dead man's switch is OFF, so a crash or a " +
        "lost connection will not alert anyone. Do not run a real deployment this way.",
    );
  }
  if (!config.alertUrl) {
    console.warn(
      "RELAYER_ALERT_URL is unset: settlement lag, low gas and chain exhaustion will be " +
        "written to the journal and nowhere else. Nobody is woken up by a journal.",
    );
  }

  const now = Date.now();
  const state: LoopState = {
    epoch,
    chain,
    lastProbeOkAt: now,
    lastBlockAdvanceAt: now,
    lastBlockNumber: await provider.getBlockNumber(),
    settleTimeout,
  };

  const deps = {
    game,
    config,
    alerter,
    balanceOf: () => provider.getBalance(wallet.address),
    blockNumber: () => provider.getBlockNumber(),
    blockTimestamp: async () => {
      // The chain's clock, never the host's. A container with a drifting clock would
      // otherwise misjudge how long a bet has been waiting and page on nothing.
      const block = await provider.getBlock("latest");
      return BigInt(block?.timestamp ?? 0);
    },
    pingAlive: () => heartbeat.ping(),
    now: () => Date.now(),
    log: (message: string) => console.log(`[relayer] ${message}`),
  };

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Settling is a single transaction, so finishing the pass in flight is enough to
      // avoid leaving a bet the next start would have to catch up on.
      console.log(`\nReceived ${signal}, finishing the current pass and stopping.`);
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      await alerter.evaluate(await runPass(deps, state));
    } catch (error) {
      // A pass that throws is reported and retried. Exiting would hand the problem to
      // the supervisor, which can only do the same thing more slowly and with less
      // context, and every second of downtime is a bet nobody is settling.
      console.error(`[relayer] pass failed: ${(error as Error).message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
