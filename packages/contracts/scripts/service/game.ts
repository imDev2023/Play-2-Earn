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

/**
 * One bet as the hand-written ABI above declares it, every field of it.
 *
 * The service itself only reads `placedAt` and `settled`, so this was once narrowed to
 * those two. That hid the field order from the type checker at exactly the point the
 * order matters most: this is the relayer's only view of a struct that #48 repacked, and
 * a tuple decoded into its neighbours does not throw. Declaring the whole tuple lets the
 * guard test in `RelayerService.ts` assert fields that cannot be mistaken for each other.
 */
export interface ServiceBet {
  player: string;
  tier: bigint;
  settled: boolean;
  placedAt: bigint;
  stake: bigint;
  clientSeed: bigint;
  commit: string;
  reveal: string;
}

/** What the service needs beyond the core's `RelayerGame`. */
export interface ServiceGame extends RelayerGame {
  SETTLE_TIMEOUT(): Promise<bigint>;
  bets(betId: bigint): Promise<ServiceBet>;
}

export function connectGame(address: string, runner: Signer | Provider): ServiceGame {
  return new Contract(address, RELAYER_GAME_ABI, runner) as unknown as ServiceGame;
}
