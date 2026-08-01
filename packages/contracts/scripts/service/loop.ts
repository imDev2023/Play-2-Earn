import { relayerHealth } from "@rushood/verifier";
import { epochChain, roundForHead, settleNextBet, shouldRotate } from "../lib/relayer-core";
import type { Alert, PassResult } from "./alerts";
import { ALERT_KEYS, Alerter, LIVENESS_KEYS } from "./alerts";
import {
  chainExhaustionAlert,
  fundingAlert,
  livenessAlert,
  settlementLagAlert,
} from "./conditions";
import type { RelayerConfig } from "./config";
import type { ServiceGame } from "./game";
import { livenessState } from "./liveness";

/**
 * The relayer's main loop (#39).
 *
 * **Polling is the backbone, not an event subscription.** The dev script drives
 * settlement from `game.on("BetPlaced")`, which has no failure surface: when the
 * transport drops, the callback stops firing, nothing throws, and the process keeps
 * running. That single design choice produces two of the three failure modes this
 * ticket exists to fix - a deaf relayer, and bets placed during downtime that are never
 * settled - and detecting it after the fact is strictly worse than not having it.
 *
 * A loop that reads `activeBetId()` every few seconds has neither problem by
 * construction. There is no subscription to drop, so it cannot go deaf; and because
 * every pass reads current state rather than reacting to a past edge, catching up after
 * downtime is not a special case but the ordinary behaviour of the first pass. The
 * latency cost is one poll interval, which is well inside the window `relayerHealth`
 * already treats as healthy.
 *
 * The same pass is the liveness probe. A successful read of the head is the evidence
 * that the connection is alive, which is what lets the dead man's switch distinguish a
 * quiet night from a dead relayer.
 */

export interface LoopDeps {
  game: ServiceGame;
  config: RelayerConfig;
  alerter: Alerter;
  /** Relayer account balance, in wei. */
  balanceOf: () => Promise<bigint>;
  blockNumber: () => Promise<number>;
  blockTimestamp: () => Promise<bigint>;
  /** Called once per pass while the connection is provably alive. */
  pingAlive: () => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

/**
 * How many epochs back `resolveEpoch` will look for the on-chain head.
 *
 * Generous: at 256 reveals an epoch this covers a quarter of a million settlements, and
 * the cost of scanning is paid once, at boot.
 */
const MAX_EPOCH_SCAN = 1000;

/** Mutable state carried between passes. */
export interface LoopState {
  epoch: number;
  chain: string[];
  lastProbeOkAt: number;
  lastBlockAdvanceAt: number;
  lastBlockNumber: number;
  settleTimeout: bigint;
}

/**
 * Find which epoch's chain the on-chain head belongs to.
 *
 * The head is authoritative, never a local counter, so this survives restarts, repeated
 * passes and a second relayer racing the same chain.
 */
export function resolveEpoch(
  masterSeed: string,
  head: string,
  chainLength: number,
): { epoch: number; chain: string[] } {
  for (let epoch = 0; epoch < MAX_EPOCH_SCAN; epoch++) {
    const chain = epochChain(masterSeed, epoch, chainLength);
    if (roundForHead(chain, head) !== 0) return { epoch, chain };
  }
  // Every reveal this relayer can produce is derived from the seed, so a head that sits
  // on none of its chains means it cannot settle anything at all. Failing loudly on boot
  // beats running as a relayer that silently settles nothing.
  throw new Error(
    "On-chain commitment is not on any chain derivable from RELAYER_SEED. " +
      "Either the seed is wrong for this deployment, or the game was deployed from a different one.",
  );
}

/** Current liveness, read from the timestamps the last successful pass left behind. */
function livenessNow(deps: LoopDeps, state: LoopState) {
  return livenessState({
    now: deps.now(),
    lastProbeOkAt: state.lastProbeOkAt,
    lastBlockAdvanceAt: state.lastBlockAdvanceAt,
    probeTimeoutMs: deps.config.probeTimeoutMs,
    blockStallMs: deps.config.blockStallMs,
  });
}

/**
 * One pass. Returns the alerts that are true right now, and which conditions it was
 * actually in a position to judge; delivery and de-duplication are the `Alerter`'s job.
 *
 * Never throws for an ordinary chain fault. A pass that fails leaves the liveness
 * timestamps untouched, which is what eventually raises `rpc-down` - the absence of a
 * successful pass is the signal, so there is nothing to catch and re-report.
 */
export async function runPass(deps: LoopDeps, state: LoopState): Promise<PassResult> {
  const { game, config, now } = deps;
  const alerts: Alert[] = [];

  let head: string;
  let activeBetId: bigint;
  let block: number;
  try {
    [head, activeBetId, block] = await Promise.all([
      game.currentCommit(),
      game.activeBetId(),
      deps.blockNumber(),
    ]);
  } catch (error) {
    deps.log(`poll failed: ${(error as Error).message}`);
    // Scoped to liveness on purpose. This pass learned nothing about the gas balance,
    // the reveal chain or the active bet, and reporting them as absent would resolve
    // every other alert and then re-raise it a second later - which is how a real
    // incident turns into a flapping check nobody trusts.
    const alert = livenessAlert(livenessNow(deps, state));
    return { alerts: alert ? [alert] : [], assessed: LIVENESS_KEYS };
  }

  state.lastProbeOkAt = now();
  if (block > state.lastBlockNumber) {
    state.lastBlockNumber = block;
    state.lastBlockAdvanceAt = now();
  }

  const liveness = livenessNow(deps, state);
  const live = livenessAlert(liveness);
  if (live) alerts.push(live);

  // The chain head moves under us on every settle, so the epoch is re-derived rather
  // than remembered. This is also what makes a restart mid-epoch a non-event.
  const round = roundForHead(state.chain, head);
  if (round === 0) {
    const resolved = resolveEpoch(config.masterSeed, head, config.chainLength);
    state.epoch = resolved.epoch;
    state.chain = resolved.chain;
  }

  const exhaustion = chainExhaustionAlert(
    roundForHead(state.chain, head),
    config.chainLength,
    config.rotationMargin,
  );
  if (exhaustion) alerts.push(exhaustion);

  if (activeBetId !== 0n) {
    const [bet, blockTime] = await Promise.all([game.bets(activeBetId), deps.blockTimestamp()]);
    const health = relayerHealth({
      activeBetId,
      placedAt: bet.placedAt,
      now: blockTime,
      settleTimeout: state.settleTimeout,
    });
    const lag = settlementLagAlert(health);
    if (lag) alerts.push(lag);

    // This settle is also the catch-up path. A bet placed while the process was down is
    // simply an active bet on the first pass, which is why downtime needs no special
    // handling and no backfill scan.
    //
    // A failed settle is logged and left for the next pass rather than thrown. The
    // transaction can revert for reasons that are already resolved by the time we hear
    // about it - the bet settled underneath us, a nonce raced - and letting that abort
    // the pass would skip the funding and liveness checks below, which is precisely
    // when an operator most needs them.
    try {
      const result = await settleNextBet(game, state.chain);
      if (result?.needsRotation) {
        deps.log(`chain exhausted at epoch ${state.epoch}; bet ${activeBetId} cannot be settled`);
      } else if (result?.settled) {
        deps.log(`settled bet ${activeBetId}: ${result.win ? "WIN" : "LOSS"}`);
      }
    } catch (error) {
      deps.log(`settle failed for bet ${activeBetId}: ${(error as Error).message}`);
    }
  } else if (shouldRotate(state.chain, head, config.rotationMargin)) {
    // Only legal between bets, which is why it is attempted here and not after a settle.
    const next = epochChain(config.masterSeed, state.epoch + 1, config.chainLength);
    await (await game.rotateChain(next[0])).wait();
    state.epoch += 1;
    state.chain = next;
    deps.log(`rotated to epoch ${state.epoch}`);
  }

  const funding = fundingAlert(await deps.balanceOf(), config.ethWarnWei, config.ethPageWei);
  if (funding) alerts.push(funding);

  // The dead man's switch is pinged only while the connection is provably alive, and
  // never from the settle path: pinging on settlement would make a night with no bets
  // indistinguishable from a dead relayer, and the false pages would get it muted.
  if (liveness === "alive") await deps.pingAlive();

  // A pass that read the chain judged every condition, so anything not listed here has
  // genuinely cleared and may be resolved.
  return { alerts, assessed: ALERT_KEYS };
}
