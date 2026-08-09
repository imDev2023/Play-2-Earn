import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { DEFAULT_MASTER_SEED } from "../scripts/lib/hashchain";
import { epochChain } from "../scripts/lib/relayer-core";
import {
  ALERT_KEYS,
  Alerter,
  ConsoleSink,
  HealthchecksHeartbeat,
  HealthchecksSink,
  LIVENESS_KEYS,
  type Alert,
  type AlertKey,
  type AlertSink,
} from "../scripts/service/alerts";
import {
  loadRelayerConfig,
  withCredentialSeed,
  type RelayerConfig,
} from "../scripts/service/config";
import { chainExhaustionAlert, fundingAlert } from "../scripts/service/conditions";
import { connectGame } from "../scripts/service/game";
import { livenessState } from "../scripts/service/liveness";
import { resolveEpoch, runPass, type LoopDeps } from "../scripts/service/loop";

/**
 * The relayer's production surface (#39).
 *
 * The relayer cannot lose player money - `refund()` after `SETTLE_TIMEOUT` covers every
 * way it can fail. What it loses is the game being playable, silently: the game settles
 * one bet at a time, so a single unsettled bet is not one unhappy player but every
 * player, until somebody notices. These tests are about noticing.
 *
 * The suites below the last one are pure. The decisions worth testing - is the
 * connection actually alive, should this page, has this already been paged - are the
 * ones a live chain would make hardest to exercise, so none of them are allowed to
 * depend on one.
 *
 * The final suite does drive a real deployment, for one reason: `service/game.ts`
 * declares the contract's ABI by hand, because Hardhat's artifacts do not exist in a
 * production container. Running the real contract through that copy is what keeps it
 * honest, so a signature change breaks a test rather than a deployment.
 */

const VALID_ENV = {
  RELAYER_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  RELAYER_GAME_ADDRESS: "0x642cf500f1ee31E3F5bDe228d448493Be35DD29C",
  RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  RELAYER_SEED: "a-real-secret-seed",
};

describe("relayer service config (#39)", () => {
  it("accepts a fully specified environment", () => {
    const config = loadRelayerConfig(VALID_ENV);
    expect(config.rpcUrl).to.equal(VALID_ENV.RELAYER_RPC_URL);
    expect(config.gameAddress).to.equal(VALID_ENV.RELAYER_GAME_ADDRESS);
    expect(config.masterSeed).to.equal(VALID_ENV.RELAYER_SEED);
  });

  /**
   * The dev script defaults the seed to a value committed in this repo. Deriving a
   * production chain from it would let anyone reproduce every future reveal, so the
   * production path must refuse it by name rather than merely prefer something else.
   */
  it("refuses the committed dev seed outright", () => {
    expect(() => loadRelayerConfig({ ...VALID_ENV, RELAYER_SEED: DEFAULT_MASTER_SEED })).to.throw(
      /dev seed/i,
    );
  });

  it("requires a seed rather than falling back to one", () => {
    const { RELAYER_SEED: _omitted, ...withoutSeed } = VALID_ENV;
    expect(() => loadRelayerConfig(withoutSeed)).to.throw(/RELAYER_SEED/);
  });

  /**
   * Reporting one missing variable per restart turns first-time setup into a guessing
   * game against a process that takes a container rebuild to retry.
   */
  it("names every missing variable at once", () => {
    let message = "";
    try {
      loadRelayerConfig({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.include("RELAYER_RPC_URL");
    expect(message).to.include("RELAYER_GAME_ADDRESS");
    expect(message).to.include("RELAYER_PRIVATE_KEY");
    expect(message).to.include("RELAYER_SEED");
  });

  it("rejects a malformed game address", () => {
    expect(() => loadRelayerConfig({ ...VALID_ENV, RELAYER_GAME_ADDRESS: "not-an-address" })).to.throw(
      /RELAYER_GAME_ADDRESS/,
    );
  });

  /**
   * A seed out of a `.env` file or a secrets manager routinely carries a trailing
   * newline. Untrimmed, it would slip past the dev-seed check by one invisible
   * character, which is the one guard between a public seed and a real deployment.
   */
  it("sees through whitespace around the committed dev seed", () => {
    expect(() =>
      loadRelayerConfig({ ...VALID_ENV, RELAYER_SEED: `${DEFAULT_MASTER_SEED}\n` }),
    ).to.throw(/dev seed/i);
  });

  it("rejects a fractional chain length rather than rounding it silently", () => {
    expect(() => loadRelayerConfig({ ...VALID_ENV, RELAYER_CHAIN_LENGTH: "100.5" })).to.throw(
      /whole number/,
    );
  });

  /**
   * `systemd-creds` is the custody mechanism the runbook recommends, and systemd
   * delivers it as a file rather than an environment variable. Without this the
   * recommended path would produce a service that refuses to boot, naming a variable
   * the operator deliberately did not set.
   */
  it("takes the seed from a systemd credential when the environment has none", () => {
    const { RELAYER_SEED: _omitted, ...withoutSeed } = VALID_ENV;
    const env = withCredentialSeed(
      { ...withoutSeed, CREDENTIALS_DIRECTORY: "/run/credentials/rushood" },
      (path) => {
        expect(path).to.equal("/run/credentials/rushood/relayer-seed");
        return "seed-from-the-credential";
      },
    );
    expect(loadRelayerConfig(env).masterSeed).to.equal("seed-from-the-credential");
  });

  it("lets an explicit environment seed win over the credential", () => {
    const env = withCredentialSeed({ ...VALID_ENV, CREDENTIALS_DIRECTORY: "/run/credentials" }, () => "from-file");
    expect(env.RELAYER_SEED).to.equal(VALID_ENV.RELAYER_SEED);
  });

  it("still fails naming RELAYER_SEED when the credential cannot be read", () => {
    const { RELAYER_SEED: _omitted, ...withoutSeed } = VALID_ENV;
    const env = withCredentialSeed({ ...withoutSeed, CREDENTIALS_DIRECTORY: "/run/credentials" }, () => {
      throw new Error("ENOENT");
    });
    expect(() => loadRelayerConfig(env)).to.throw(/RELAYER_SEED/);
  });

  it("never puts the seed or the key in the error it throws", () => {
    let message = "";
    try {
      loadRelayerConfig({ ...VALID_ENV, RELAYER_GAME_ADDRESS: "bad" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.not.include(VALID_ENV.RELAYER_SEED);
    expect(message).to.not.include(VALID_ENV.RELAYER_PRIVATE_KEY);
  });
});

describe("relayer liveness (#39)", () => {
  const NOW = 1_000_000;
  const BASE = { now: NOW, probeTimeoutMs: 30_000, blockStallMs: 120_000 };

  it("is alive while probes succeed and the head advances", () => {
    expect(
      livenessState({ ...BASE, lastProbeOkAt: NOW - 5_000, lastBlockAdvanceAt: NOW - 5_000 }),
    ).to.equal("alive");
  });

  /**
   * The failure this whole mechanism exists for. `game.on(BetPlaced)` has no error
   * surface: a dropped subscription leaves the process running and the callback simply
   * never fires again. Nothing throws, so only the absence of a signal reveals it.
   */
  it("reports rpc-down when probes stop succeeding", () => {
    expect(
      livenessState({ ...BASE, lastProbeOkAt: NOW - 100_000, lastBlockAdvanceAt: NOW - 5_000 }),
    ).to.equal("rpc-down");
  });

  /**
   * A reachable node whose head is frozen is still useless to us, and it is a different
   * fault with a different fix, so it must not be reported as the same thing.
   */
  it("distinguishes a stalled chain from an unreachable node", () => {
    expect(
      livenessState({ ...BASE, lastProbeOkAt: NOW - 5_000, lastBlockAdvanceAt: NOW - 200_000 }),
    ).to.equal("chain-stalled");
  });

  /**
   * The one false positive that would matter: a quiet night with no bets must look
   * exactly like a busy one. Liveness is derived from the head advancing, never from
   * settlements, precisely so that an idle relayer is not mistaken for a dead one.
   */
  it("stays alive through a period with no bets at all", () => {
    expect(
      livenessState({ ...BASE, lastProbeOkAt: NOW - 1_000, lastBlockAdvanceAt: NOW - 1_000 }),
    ).to.equal("alive");
  });
});

describe("relayer funding and chain exhaustion (#39)", () => {
  const WARN = 10n ** 16n; // 0.01 ETH
  const PAGE = 10n ** 15n; // 0.001 ETH

  it("stays quiet while the balance is comfortable", () => {
    expect(fundingAlert(10n ** 18n, WARN, PAGE)).to.equal(null);
  });

  it("warns before it pages", () => {
    expect(fundingAlert(WARN - 1n, WARN, PAGE)?.severity).to.equal("warn");
    expect(fundingAlert(PAGE - 1n, WARN, PAGE)?.severity).to.equal("page");
  });

  it("stays quiet well before rotation is due", () => {
    expect(chainExhaustionAlert(200, 256, 4)).to.equal(null);
  });

  /**
   * The relayer rotates itself at `chainLength - margin`, so that point is routine
   * behaviour rather than an incident. Paging there would fire on every healthy
   * rotation for the life of the deployment, and the pager would be muted long before
   * the one rotation that actually failed.
   */
  it("stays quiet at the rotation point itself, which the relayer handles", () => {
    expect(chainExhaustionAlert(252, 256, 4)).to.equal(null);
  });

  /**
   * Climbing past the rotation point is the real signal: rotation was due and did not
   * happen. Either the relayer is down, or bets are arriving continuously and it never
   * gets the between-bets window that rotation requires.
   */
  it("pages once rotation is overdue", () => {
    expect(chainExhaustionAlert(253, 256, 4)?.severity).to.equal("page");
  });

  /**
   * Past the end there is no reveal left to publish, so the active bet cannot be
   * settled at all and can only be refunded. That is worse than lag, not equal to it.
   */
  it("still fires once the chain is fully exhausted", () => {
    expect(chainExhaustionAlert(256, 256, 4)?.severity).to.equal("page");
  });
});

describe("relayer alert dedupe (#39)", () => {
  function recordingSink() {
    const delivered: Alert[] = [];
    const resolved: AlertKey[] = [];
    const sink: AlertSink = {
      deliver: async (alert) => {
        delivered.push(alert);
      },
      resolve: async (key) => {
        resolved.push(key);
      },
    };
    return { sink, delivered, resolved };
  }

  const LAGGING: Alert = { key: "settlement-lag", severity: "page", summary: "Bet #1 unsettled" };

  /** A pass that saw everything: the ordinary case, where silence means cleared. */
  const sawEverything = (alerts: Alert[]) => ({ alerts, assessed: ALERT_KEYS });

  /**
   * The loop re-evaluates every few seconds. Delivering on each pass would turn one
   * incident into hundreds of pages, and the practical result of that is a muted pager
   * on the night it matters.
   */
  it("delivers a firing condition once, not once per evaluation", async () => {
    const { sink, delivered } = recordingSink();
    const alerter = new Alerter(sink);

    await alerter.evaluate(sawEverything([LAGGING]));
    await alerter.evaluate(sawEverything([LAGGING]));
    await alerter.evaluate(sawEverything([LAGGING]));

    expect(delivered).to.have.lengthOf(1);
  });

  it("resolves when the condition clears, and re-fires if it returns", async () => {
    const { sink, delivered, resolved } = recordingSink();
    const alerter = new Alerter(sink);

    await alerter.evaluate(sawEverything([LAGGING]));
    await alerter.evaluate(sawEverything([]));
    await alerter.evaluate(sawEverything([LAGGING]));

    expect(resolved).to.deep.equal(["settlement-lag"]);
    expect(delivered).to.have.lengthOf(2);
  });

  /**
   * The bug this scoping exists to prevent. A single failed poll can only speak to
   * liveness; if its silence about everything else counted as evidence, an ongoing
   * funding page would be resolved and then re-raised on the next successful pass,
   * every few seconds, for as long as the node flapped.
   */
  it("does not resolve conditions a failed pass was in no position to judge", async () => {
    const { sink, resolved } = recordingSink();
    const alerter = new Alerter(sink);
    const funding: Alert = { key: "relayer-funding", severity: "page", summary: "out of gas" };

    await alerter.evaluate(sawEverything([funding]));
    // A pass that could not reach the node at all: it knows nothing about the balance.
    await alerter.evaluate({
      alerts: [{ key: "rpc-down", severity: "page", summary: "unreachable" }],
      assessed: LIVENESS_KEYS,
    });

    expect(resolved).to.deep.equal([]);
    expect(alerter.active()).to.include("relayer-funding");
  });

  it("still resolves a liveness alert on a pass that only judged liveness", async () => {
    const { sink, resolved } = recordingSink();
    const alerter = new Alerter(sink);

    await alerter.evaluate({
      alerts: [{ key: "rpc-down", severity: "page", summary: "unreachable" }],
      assessed: LIVENESS_KEYS,
    });
    await alerter.evaluate({ alerts: [], assessed: LIVENESS_KEYS });

    expect(resolved).to.deep.equal(["rpc-down"]);
  });

  /**
   * An escalation is new information even though the key has not changed, so it must
   * break through the dedupe that a repeat of the same severity would not.
   */
  it("re-delivers when a warning escalates to a page", async () => {
    const { sink, delivered } = recordingSink();
    const alerter = new Alerter(sink);

    await alerter.evaluate(
      sawEverything([{ key: "relayer-funding", severity: "warn", summary: "low" }]),
    );
    await alerter.evaluate(
      sawEverything([{ key: "relayer-funding", severity: "page", summary: "critical" }]),
    );

    expect(delivered.map((a) => a.severity)).to.deep.equal(["warn", "page"]);
  });

  /**
   * A sink that throws is a monitoring outage, not a reason to take the relayer down
   * with it. Settling bets matters more than reporting on settling bets.
   */
  it("survives a sink that throws", async () => {
    const alerter = new Alerter({
      deliver: async () => {
        throw new Error("healthchecks.io unreachable");
      },
      resolve: async () => {},
    });

    await alerter.evaluate(sawEverything([LAGGING]));
  });
});

/**
 * The dead man's switch and the alert channel must be two different Healthchecks.io
 * checks (#39).
 *
 * Sharing one is worse than having no alerting: the heartbeat pings the check back up
 * within a poll interval of any page, and the dedupe means the page is never
 * re-delivered, so the dashboard reads green for the rest of the outage.
 */
describe("relayer alert destinations (#39)", () => {
  function recordingFetch() {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return new Response("ok");
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("posts failures to /fail on the alert check and recoveries to its base URL", async () => {
    const { impl, calls } = recordingFetch();
    const sink = new HealthchecksSink("https://hc.example/alert", impl);

    await sink.deliver({ key: "settlement-lag", severity: "page", summary: "stuck" });
    await sink.resolve("settlement-lag");

    expect(calls).to.deep.equal(["https://hc.example/alert/fail", "https://hc.example/alert"]);
  });

  it("pings the heartbeat check, which is a different URL entirely", async () => {
    const { impl, calls } = recordingFetch();
    await new HealthchecksHeartbeat("https://hc.example/alive", impl).ping();

    expect(calls).to.deep.equal(["https://hc.example/alive"]);
  });

  it("refuses to boot when both are pointed at the same check", () => {
    expect(() =>
      loadRelayerConfig({
        ...VALID_ENV,
        RELAYER_HEALTHCHECK_URL: "https://hc.example/same",
        RELAYER_ALERT_URL: "https://hc.example/same",
      }),
    ).to.throw(/different Healthchecks.io checks/);
  });

  it("accepts two distinct checks", () => {
    const config = loadRelayerConfig({
      ...VALID_ENV,
      RELAYER_HEALTHCHECK_URL: "https://hc.example/alive",
      RELAYER_ALERT_URL: "https://hc.example/alert",
    });
    expect(config.healthcheckPingUrl).to.equal("https://hc.example/alive");
    expect(config.alertUrl).to.equal("https://hc.example/alert");
  });
});

describe("relayer service against a live game (#39)", () => {
  const SEED = "a-real-secret-seed";
  const CHAIN_LENGTH = 16;
  const COINFLIP_TIER = 0;
  const BET_AMOUNT = 100n * 10n ** 18n;

  async function deploy() {
    const [deployer, player, relayer] = await ethers.getSigners();
    const chain = epochChain(SEED, 0, CHAIN_LENGTH);

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
      await rush.getAddress(),
    );
    const game = await (await ethers.getContractFactory("RushoodGame")).deploy(
      await rush.getAddress(),
      await treasury.getAddress(),
      chain[0],
      relayer.address,
    );
    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), 100_000n * 10n ** 18n);
    await rush.transfer(player.address, 1_000n * 10n ** 18n);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return { game, player, relayer, chain, address: await game.getAddress() };
  }

  async function makeDeps(address: string, relayer: HardhatEthersSigner, config: RelayerConfig) {
    const game = connectGame(address, relayer);
    const logged: string[] = [];
    const pings: number[] = [];
    const deps: LoopDeps = {
      game,
      config,
      alerter: new Alerter(new ConsoleSink()),
      balanceOf: () => ethers.provider.getBalance(relayer.address),
      blockNumber: () => ethers.provider.getBlockNumber(),
      blockTimestamp: async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp),
      pingAlive: async () => {
        pings.push(Date.now());
      },
      now: () => Date.now(),
      log: (m) => logged.push(m),
    };
    return { deps, game, logged, pings };
  }

  function configFor(): RelayerConfig {
    return loadRelayerConfig({
      ...VALID_ENV,
      RELAYER_SEED: SEED,
      RELAYER_CHAIN_LENGTH: String(CHAIN_LENGTH),
      RELAYER_ROTATION_MARGIN: "2",
    });
  }

  async function freshState(game: ReturnType<typeof connectGame>, config: RelayerConfig) {
    const head = await game.currentCommit();
    const { epoch, chain } = resolveEpoch(config.masterSeed, head, config.chainLength);
    const now = Date.now();
    return {
      epoch,
      chain,
      lastProbeOkAt: now,
      lastBlockAdvanceAt: now,
      lastBlockNumber: await ethers.provider.getBlockNumber(),
      settleTimeout: await game.SETTLE_TIMEOUT(),
    };
  }

  /**
   * The ABI in `service/game.ts` is written by hand, because Hardhat's artifacts do not
   * exist in a production container. Driving the real contract through it is what keeps
   * that copy honest: a signature change breaks this test rather than a deployment.
   */
  it("drives the real contract through the hand-written ABI", async () => {
    const { game: deployed, player, address, relayer } = await deploy();
    const game = connectGame(address, relayer);

    expect(await game.activeBetId()).to.equal(0n);
    expect(await game.SETTLE_TIMEOUT()).to.equal(3600n);
    expect(await game.currentCommit()).to.match(/^0x[0-9a-f]{64}$/i);

    // Against a real bet, and reading fields that cannot be mistaken for each other.
    // `bets(0)` was doing this job and could not: no bet zero exists, so every word
    // comes back zero and the assertion holds for any field order the ABI declares.
    // The layout is packed (#47) and the hand-written copy is the relayer's only view
    // of it, so a reorder here has to fail loudly rather than decode `stake` into
    // `placedAt` and floor every settlement-lag alert at zero.
    await deployed.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 7n);
    const bet = await game.bets(1n);
    expect(bet.settled).to.equal(false);
    expect(bet.stake).to.equal(BET_AMOUNT);
    expect(bet.clientSeed).to.equal(7n);
    expect(bet.player).to.equal(player.address);
    expect(bet.tier).to.equal(BigInt(COINFLIP_TIER));
    // A plausible unix timestamp, and nothing else in the tuple is one: the stake is
    // 1e20, the seed is 7, and the two hashes are not numbers.
    expect(bet.placedAt).to.be.greaterThan(1_600_000_000n);
    expect(bet.placedAt).to.be.lessThan(4_000_000_000n);
  });

  /**
   * The gap this ticket exists to close. The dev script only ever settles in response to
   * a live `BetPlaced`, so a bet placed while it was down produces no event on restart
   * and is left to time out into a refund.
   *
   * Here the bet is placed with no relayer running at all, and the loop is then started
   * from scratch - no event is ever delivered, because the loop does not use events.
   * Catch-up is not a special case; it is what the ordinary first pass does.
   */
  it("settles a bet placed while it was down, on the first pass after restart", async () => {
    const { game: deployed, player, relayer, address } = await deploy();
    const config = configFor();

    await deployed.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
    expect(await deployed.activeBetId()).to.equal(1n);

    const { deps, game } = await makeDeps(address, relayer, config);
    await runPass(deps, await freshState(game, config));

    expect(await deployed.activeBetId()).to.equal(0n);
    expect((await deployed.bets(1n)).settled).to.equal(true);
  });

  /**
   * Rotation is only legal between bets, so the loop must take the opportunity when the
   * game is idle rather than waiting for a settle to trigger it.
   */
  it("rotates between bets once the chain nears exhaustion", async () => {
    const { game: deployed, player, relayer, address } = await deploy();
    const config = configFor();
    const { deps, game } = await makeDeps(address, relayer, config);

    // Walk the head down the chain until rotation is due, settling a bet each round.
    let state = await freshState(game, config);
    for (let i = 0; i < CHAIN_LENGTH - config.rotationMargin - 1; i++) {
      await deployed.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, BigInt(i + 1));
      await runPass(deps, state);
    }

    const epochBefore = state.epoch;
    await runPass(deps, state); // idle pass: nothing to settle, rotation is due
    expect(state.epoch).to.equal(epochBefore + 1);
  });

  /**
   * A node that cannot be reached must raise `rpc-down` rather than throw. The absence
   * of a successful pass is the signal, and the loop has to stay up to keep producing it.
   */
  it("reports rpc-down instead of throwing when the chain is unreachable", async () => {
    const { address, relayer } = await deploy();
    const config = configFor();
    const { deps, game } = await makeDeps(address, relayer, config);
    const state = await freshState(game, config);

    // A game whose reads always fail stands in for a dropped connection.
    const broken = {
      ...deps,
      game: {
        ...deps.game,
        currentCommit: async () => {
          throw new Error("connection reset");
        },
        activeBetId: async () => {
          throw new Error("connection reset");
        },
      } as unknown as typeof deps.game,
      now: () => Date.now() + config.probeTimeoutMs + 1_000,
    };

    const { alerts, assessed } = await runPass(broken, state);
    expect(alerts.map((a) => a.key)).to.include("rpc-down");
    // And it says so: the pass could not read the chain, so it must not claim to have
    // judged the gas balance or the reveal chain.
    expect([...assessed]).to.deep.equal([...LIVENESS_KEYS]);
  });

  /**
   * A settle that reverts must not take the rest of the pass with it. The funding and
   * liveness checks that follow it are exactly what an operator needs at that moment,
   * and skipping them would also strand every already-firing alert.
   */
  it("keeps assessing the pass when a settle fails", async () => {
    const { game: deployed, player, relayer, address } = await deploy();
    const config = configFor();
    const { deps, game, logged } = await makeDeps(address, relayer, config);
    const state = await freshState(game, config);

    await deployed.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);

    // Delegated by hand rather than spread: the contract's methods live on a proxy, so
    // `{ ...game }` would quietly produce an object with none of them.
    const failingSettle = {
      ...deps,
      game: {
        activeBetId: () => deps.game.activeBetId(),
        currentCommit: () => deps.game.currentCommit(),
        SETTLE_TIMEOUT: () => deps.game.SETTLE_TIMEOUT(),
        bets: (id: bigint) => deps.game.bets(id),
        rotateChain: (genesis: string) => deps.game.rotateChain(genesis),
        interface: deps.game.interface,
        settleBet: async () => {
          throw new Error("execution reverted");
        },
      } as unknown as typeof deps.game,
    };

    const { assessed } = await runPass(failingSettle, state);

    expect(logged.join("\n")).to.match(/settle failed/);
    expect([...assessed]).to.deep.equal([...ALERT_KEYS]);
    expect(await deployed.activeBetId()).to.equal(1n);
  });

  /**
   * Rotation races ordinary play: a bet placed between the `activeBetId()` read and the
   * transaction landing makes it revert. That is traffic, not a fault, so the pass must
   * survive it and the epoch must not advance on a rotation that never happened.
   */
  it("keeps its epoch when a rotation loses the race and reverts", async () => {
    const { player, game: deployed, relayer, address } = await deploy();
    const config = configFor();
    const { deps, game, logged } = await makeDeps(address, relayer, config);

    let state = await freshState(game, config);
    for (let i = 0; i < CHAIN_LENGTH - config.rotationMargin - 1; i++) {
      await deployed.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, BigInt(i + 1));
      await runPass(deps, state);
    }

    const failingRotate = {
      ...deps,
      game: {
        activeBetId: () => deps.game.activeBetId(),
        currentCommit: () => deps.game.currentCommit(),
        SETTLE_TIMEOUT: () => deps.game.SETTLE_TIMEOUT(),
        bets: (id: bigint) => deps.game.bets(id),
        settleBet: (reveal: string) => deps.game.settleBet(reveal),
        interface: deps.game.interface,
        rotateChain: async () => {
          throw new Error("CannotRotateMidBet");
        },
      } as unknown as typeof deps.game,
    };

    const epochBefore = state.epoch;
    const { assessed } = await runPass(failingRotate, state);

    expect(state.epoch).to.equal(epochBefore);
    expect(logged.join("\n")).to.match(/rotation failed/);
    expect([...assessed]).to.deep.equal([...ALERT_KEYS]);
  });

  /**
   * A balance read that fails is an RPC fault, not an empty wallet. Reporting it as one
   * would page an operator to top up an account that is already funded.
   */
  it("does not report a failed balance read as an empty wallet", async () => {
    const { address, relayer } = await deploy();
    const config = configFor();
    const { deps, game, logged } = await makeDeps(address, relayer, config);
    const state = await freshState(game, config);

    const { alerts } = await runPass(
      {
        ...deps,
        balanceOf: async () => {
          throw new Error("connection reset");
        },
      },
      state,
    );

    expect(alerts.map((a) => a.key)).to.not.include("relayer-funding");
    expect(logged.join("\n")).to.match(/balance read failed/);
  });

  /**
   * A head that sits on no derivable chain means this relayer can settle nothing at
   * all. Discovered at boot that is a refusal to start; discovered mid-flight the
   * process is already up, and the only useful thing it can do is page rather than
   * throw its way through every remaining check.
   */
  it("pages instead of throwing when the head is on no chain it can derive", async () => {
    const { address, relayer } = await deploy();
    const config = configFor();
    const { deps, game } = await makeDeps(address, relayer, config);
    const state = await freshState(game, config);

    const foreignHead = ethers.keccak256(ethers.toUtf8Bytes("a chain from a different seed"));
    const stranded = {
      ...deps,
      game: {
        ...deps.game,
        currentCommit: async () => foreignHead,
        activeBetId: async () => 0n,
      } as unknown as typeof deps.game,
    };

    const { alerts, assessed } = await runPass(stranded, state);

    expect(alerts.map((a) => a.key)).to.include("seed-mismatch");
    expect(alerts.find((a) => a.key === "seed-mismatch")?.severity).to.equal("page");
    expect([...assessed]).to.deep.equal([...ALERT_KEYS]);
  });
});
