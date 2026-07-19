import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { buildHashChain, DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";

/**
 * Local relayer stand-in for the walking skeleton.
 *
 * Watches `BetPlaced` and settles each bet by revealing the next node of the server
 * hash chain. This is the LOCAL DEV substitute for the real off-chain relayer (#19);
 * it derives the chain from the same master seed the deploy script used and holds no
 * secrets. Run against a persistent node (localhost), not the in-process network.
 *
 *   npx hardhat run scripts/relayer.ts --network localhost
 */
const MASTER_SEED = process.env.RELAYER_SEED ?? DEFAULT_MASTER_SEED;
const CHAIN_LENGTH = Number(process.env.RELAYER_CHAIN_LENGTH ?? DEFAULT_CHAIN_LENGTH);

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
  const chain = buildHashChain(MASTER_SEED, CHAIN_LENGTH);
  const { game: gameAddress } = loadDeployment();

  // Settling is permissionless, so any funded signer works as the relayer.
  const signers = await ethers.getSigners();
  const relayer = signers[2] ?? signers[0];
  const game = await ethers.getContractAt("RushoodGame", gameAddress, relayer);

  const startHead: string = await game.currentCommit();
  if (chain.indexOf(startHead) < 0) {
    throw new Error("Current commit is not on this relayer's chain — seed mismatch.");
  }
  console.log(
    `Relayer ready on ${network.name}. Game ${gameAddress}, next round ${chain.indexOf(startHead) + 1}.`,
  );

  game.on(game.getEvent("BetPlaced"), async (betId) => {
    // Derive the reveal from the live chain head each time rather than a local
    // counter, so duplicate events, restarts, and racing instances self-resolve:
    // whoever settles first advances the head, and the loser simply no-ops.
    if ((await game.activeBetId()) === 0n) return; // already settled by someone else
    const head: string = await game.currentCommit();
    const round = chain.indexOf(head) + 1;
    if (round === 0) {
      console.error("Chain head is off this relayer's chain — seed mismatch.");
      return;
    }
    if (round >= chain.length) {
      console.error(`Hash chain exhausted at round ${round}; increase RELAYER_CHAIN_LENGTH.`);
      return;
    }

    try {
      const receipt = await (await game.settleBet(chain[round])).wait();
      const settled = receipt?.logs
        .map((log) => game.interface.parseLog(log))
        .find((parsed) => parsed?.name === "BetSettled");
      const win = settled?.args?.win as boolean | undefined;
      const payout = settled?.args?.payout as bigint | undefined;
      console.log(
        `Settled bet ${betId} for ${settled?.args?.player}: ${win ? "WIN" : "LOSS"}` +
          (win ? ` (+${ethers.formatUnits(payout ?? 0n, 18)} RUSH)` : ""),
      );
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
