import type { ContractTransactionResponse, Interface, Log } from "ethers";
import { buildHashChain } from "./hashchain";

/**
 * The slice of RushoodGame the relayer core drives. Kept structural so both the
 * relayer script and the tests can pass a connected contract without a typechain
 * import here.
 */
export interface RelayerGame {
  activeBetId(): Promise<bigint>;
  currentCommit(): Promise<string>;
  settleBet(reveal: string): Promise<ContractTransactionResponse>;
  rotateChain(newGenesis: string): Promise<ContractTransactionResponse>;
  interface: Interface;
}

export interface SettleResult {
  settled: boolean;
  win?: boolean;
  payout?: bigint;
  /** True when the chain is exhausted and must be rotated before more bets. */
  needsRotation?: boolean;
}

/** Derive the per-epoch reveal chain. Rotating = advancing the epoch. */
export function epochChain(masterSeed: string, epoch: number, length: number): string[] {
  return buildHashChain(`${masterSeed}:${epoch}`, length);
}

/** Round the given head sits at: 1-based reveal index, or 0 if the head is off-chain. */
export function roundForHead(chain: string[], head: string): number {
  return chain.indexOf(head) + 1;
}

/**
 * Whether the chain should be rotated: the head is on this chain and within
 * `margin` reveals of the end. Returns false when the head is off-chain (round 0).
 */
export function shouldRotate(chain: string[], head: string, margin: number): boolean {
  const round = roundForHead(chain, head);
  return round > 0 && round >= chain.length - margin;
}

/**
 * Settle the active bet by revealing the next node of `chain`.
 *
 * Returns null when there's no active bet, `{ needsRotation: true }` when the chain
 * is exhausted, and otherwise the settlement outcome. Deriving the reveal from the
 * live chain head (not a local counter) keeps this safe across duplicate events,
 * restarts, and racing relayer instances.
 */
export async function settleNextBet(
  game: RelayerGame,
  chain: string[],
): Promise<SettleResult | null> {
  if ((await game.activeBetId()) === 0n) return null;

  const head = await game.currentCommit();
  const round = roundForHead(chain, head);
  if (round === 0) {
    throw new Error("chain head is off this relayer's chain - seed mismatch");
  }
  if (round >= chain.length) {
    return { settled: false, needsRotation: true };
  }

  const receipt = await (await game.settleBet(chain[round])).wait();
  const settled = receipt?.logs
    .map((log: Log) => {
      try {
        return game.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "BetSettled");

  return {
    settled: true,
    win: settled?.args?.win as boolean | undefined,
    payout: settled?.args?.payout as bigint | undefined,
  };
}
