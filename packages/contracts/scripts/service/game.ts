import { Contract, type Provider, type Signer } from "ethers";
import type { RelayerGame } from "../lib/relayer-core";

/**
 * The slice of `RushoodGame` the service binds to, declared by hand (#39).
 *
 * Hardhat's generated artifacts are not available in a production container, and
 * pulling them in would drag the whole toolchain along with them for the sake of six
 * signatures. Declaring them here is the same trade the frontend already makes in
 * `packages/web/lib/contracts.ts`.
 *
 * The suite guards the copy: `RelayerService.ts` checks these fragments against the
 * compiled contract, so a signature change breaks a test rather than a deployment.
 */
export const RELAYER_GAME_ABI = [
  "function activeBetId() view returns (uint128)",
  "function currentCommit() view returns (bytes32)",
  "function SETTLE_TIMEOUT() view returns (uint256)",
  "function bets(uint256) view returns (address player, uint8 tier, bool settled, uint64 placedAt, uint256 stake, uint256 clientSeed, bytes32 commit, bytes32 reveal)",
  "function settleBet(bytes32 reveal)",
  "function rotateChain(bytes32 newGenesis)",
] as const;

/** What the service needs beyond the core's `RelayerGame`. */
export interface ServiceGame extends RelayerGame {
  SETTLE_TIMEOUT(): Promise<bigint>;
  bets(betId: bigint): Promise<{ placedAt: bigint; settled: boolean }>;
}

export function connectGame(address: string, runner: Signer | Provider): ServiceGame {
  return new Contract(address, RELAYER_GAME_ABI, runner) as unknown as ServiceGame;
}
