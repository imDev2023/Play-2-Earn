import { keccak256, solidityPacked } from "ethers";

/**
 * Shared dev-chain defaults. The deploy script and relayer MUST derive the same
 * chain, so these live here rather than being copied into each script.
 */
export const DEFAULT_MASTER_SEED = "rushood-dev-seed";
export const DEFAULT_CHAIN_LENGTH = 256;

/**
 * Build a reveal hash chain for the per-play commit-reveal.
 *
 * Returns `nodes` where `nodes[i] = keccak256(nodes[i+1])`, so:
 *   - `nodes[0]` is the genesis commitment deployed as the chain head, and
 *   - `nodes[k]` (k >= 1) is the reveal for round k, satisfying
 *     `keccak256(nodes[k]) == nodes[k-1]` - exactly what `settleBet` checks.
 *
 * The tail is derived deterministically from `masterSeed` so the deploy script and
 * the relayer stand-in compute an identical chain. This is a LOCAL DEV construction:
 * a real relayer keeps the seed secret and never derives it reproducibly.
 */
export function buildHashChain(masterSeed: string, length: number): string[] {
  if (length < 2) throw new Error("hash chain length must be >= 2");
  const nodes: string[] = new Array(length);
  nodes[length - 1] = keccak256(solidityPacked(["string", "uint256"], [masterSeed, length - 1]));
  for (let i = length - 2; i >= 0; i--) {
    nodes[i] = keccak256(nodes[i + 1]);
  }
  return nodes;
}
