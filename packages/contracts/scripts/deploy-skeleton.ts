import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { buildHashChain, DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";

/**
 * Deploy the walking-skeleton stack (RUSH + Treasury + RushoodGame) to a local chain,
 * wire them together, and fund the treasury and a dev player.
 *
 *   Terminal 1: npx hardhat node
 *   Terminal 2: npx hardhat run scripts/deploy-skeleton.ts --network localhost
 *   Terminal 3: npx hardhat run scripts/relayer.ts --network localhost
 *
 * Writes deployments/<network>.json for the relayer and the frontend to consume.
 */
const MASTER_SEED = process.env.RELAYER_SEED ?? DEFAULT_MASTER_SEED;
const CHAIN_LENGTH = Number(process.env.RELAYER_CHAIN_LENGTH ?? DEFAULT_CHAIN_LENGTH);
const TREASURY_FUNDING = 1_000_000n * 10n ** 18n;
const PLAYER_FUNDING = 10_000n * 10n ** 18n;

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, player] = signers;
  const genesis = buildHashChain(MASTER_SEED, CHAIN_LENGTH)[0];

  const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
  await rush.waitForDeployment();

  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
    await rush.getAddress(),
  );
  await treasury.waitForDeployment();

  const game = await (await ethers.getContractFactory("RushoodGame")).deploy(
    await rush.getAddress(),
    await treasury.getAddress(),
    genesis,
  );
  await game.waitForDeployment();

  await (await treasury.setGame(await game.getAddress())).wait();
  await (await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING)).wait();
  if (player) {
    await (await rush.transfer(player.address, PLAYER_FUNDING)).wait();
  }

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rush: await rush.getAddress(),
    treasury: await treasury.getAddress(),
    game: await game.getAddress(),
    genesisCommit: genesis,
    devPlayer: player?.address ?? null,
  };

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${network.name}.json`), JSON.stringify(deployment, null, 2) + "\n");

  console.log("Walking skeleton deployed:");
  console.table(deployment);
  console.log(`\nDeployment written to deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
