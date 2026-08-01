import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";
import { epochChain, roundForHead, settleNextBet, shouldRotate } from "./lib/relayer-core";

/**
 * Local relayer for the game.
 *
 * Watches `BetPlaced`, settles each bet by revealing the next node of the server
 * hash chain (sponsoring its own gas), and rotates to a fresh chain before the
 * current one is exhausted. This is the LOCAL DEV substitute for a hardened
 * off-chain relayer; it derives chains from the same master seed the deploy script
 * used and holds no secrets. Run against a persistent node (localhost).
 *
 *   npx hardhat run scripts/relayer.ts --network localhost
 */
/**
 * The committed default is a local-development convenience and a public value: anyone
 * reading this repository can rebuild the whole reveal chain from it and know every
 * future roll before it is placed. `deploy-launch.ts` already refuses it off localhost;
 * so does this, because a dev script pointed at a public network by accident is exactly
 * how it would otherwise be used (#39).
 *
 * For anything that is not a local node, run `scripts/relayer-service.ts` instead.
 */
const MASTER_SEED = process.env.RELAYER_SEED ?? DEFAULT_MASTER_SEED;
if (MASTER_SEED === DEFAULT_MASTER_SEED && network.name !== "localhost" && network.name !== "hardhat") {
  throw new Error(
    `RELAYER_SEED is unset on "${network.name}", so the committed dev seed would be used. ` +
      "It is public: every future roll would be predictable in advance. Set a secret seed, " +
      "and use scripts/relayer-service.ts for any real deployment.",
  );
}
const CHAIN_LENGTH = Number(process.env.RELAYER_CHAIN_LENGTH ?? DEFAULT_CHAIN_LENGTH);
// Rotate once the head reaches this many reveals from the end of the chain.
const ROTATION_MARGIN = Number(process.env.RELAYER_ROTATION_MARGIN ?? 4);
// Upper bound on the epoch-recovery scan when resuming (guards a runaway loop).
const MAX_EPOCH_SCAN = 1000;

function loadDeployment() {
  const path = join(__dirname, "..", "deployments", `${network.name}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { game: string };
  } catch {
    throw new Error(
      `No deployment at ${path}. Run deploy-skeleton.ts on "${network.name}" first.`,
    );
  }
}

async function main() {
  const { game: gameAddress } = loadDeployment();
  const relayer = (await ethers.getSigners())[2] ?? (await ethers.getSigners())[0];
  const game = await ethers.getContractAt("RushoodGame", gameAddress, relayer);

  // Find which epoch's chain the current head belongs to (survives restarts).
  let epoch = 0;
  let chain = epochChain(MASTER_SEED, epoch, CHAIN_LENGTH);
  const startHead: string = await game.currentCommit();
  while (roundForHead(chain, startHead) === 0 && epoch < MAX_EPOCH_SCAN) {
    chain = epochChain(MASTER_SEED, ++epoch, CHAIN_LENGTH);
  }
  if (roundForHead(chain, startHead) === 0) {
    throw new Error("Current commit is not on any of this relayer's chains — seed mismatch.");
  }
  console.log(
    `Relayer ready on ${network.name}. Game ${gameAddress}, epoch ${epoch}, next round ${roundForHead(chain, startHead)}.`,
  );

  // Rotate to the next epoch's chain when the head nears the end. Only valid
  // between bets, which the contract enforces.
  async function rotateIfNearExhaustion() {
    if ((await game.activeBetId()) !== 0n) return;
    if (shouldRotate(chain, await game.currentCommit(), ROTATION_MARGIN)) {
      const next = epochChain(MASTER_SEED, epoch + 1, CHAIN_LENGTH);
      await (await game.rotateChain(next[0])).wait();
      epoch += 1;
      chain = next;
      console.log(`Rotated to epoch ${epoch}.`);
    }
  }

  // Rotate on resume too: after downtime the head may be near exhaustion (or a
  // stale reveal may have leaked via a refunded bet), so don't wait for a settle.
  await rotateIfNearExhaustion();

  game.on(game.getEvent("BetPlaced"), async (betId) => {
    try {
      const result = await settleNextBet(game, chain);
      if (result === null) return; // already settled by someone else
      if (result.needsRotation) {
        console.warn(`Chain exhausted mid-bet at epoch ${epoch}; cannot settle bet ${betId}.`);
        return;
      }
      console.log(
        `Settled bet ${betId}: ${result.win ? "WIN" : "LOSS"}` +
          (result.win ? ` (+${ethers.formatUnits(result.payout ?? 0n, 18)} RUSH)` : ""),
      );
      await rotateIfNearExhaustion();
    } catch (error) {
      // A concurrent settle may have won the race; that's expected, not fatal.
      console.warn(`Could not settle bet ${betId} (already settled?):`, (error as Error).message);
    }
  });

  // Keep the process alive to listen for events.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
