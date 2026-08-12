import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";
import { epochChain } from "./lib/relayer-core";

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
// Governance handoff (#22): when GOVERNANCE_SAFE is set, deploy a Timelock controlled by
// that Safe and migrate the game's governance (policy) and guardian (pause) roles to it.
// Left unset for local dev, the deployer keeps both roles for convenience.
const GOVERNANCE_SAFE = process.env.GOVERNANCE_SAFE;
const TIMELOCK_MIN_DELAY = BigInt(process.env.TIMELOCK_MIN_DELAY ?? 2 * 24 * 60 * 60); // 2 days

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, player, relayer] = signers;
  // Epoch 0 chain; the relayer advances epochs as it rotates.
  const genesis = epochChain(MASTER_SEED, 0, CHAIN_LENGTH)[0];
  const relayerAddress = (relayer ?? deployer).address;

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
    relayerAddress,
  );
  await game.waitForDeployment();

  await (await treasury.setGame(await game.getAddress())).wait();
  await (await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING)).wait();
  if (player) {
    await (await rush.transfer(player.address, PLAYER_FUNDING)).wait();
  }

  // Optional governance handoff: game.governance -> Timelock (Safe-controlled),
  // game.guardian -> Safe. Setters run while the deployer still holds the roles.
  let timelockAddress: string | null = null;
  if (GOVERNANCE_SAFE) {
    const timelock = await (await ethers.getContractFactory("RushoodTimelock")).deploy(
      TIMELOCK_MIN_DELAY,
      [GOVERNANCE_SAFE],
      [GOVERNANCE_SAFE],
      ethers.ZeroAddress,
    );
    await timelock.waitForDeployment();
    timelockAddress = await timelock.getAddress();
    await (await game.setGuardian(GOVERNANCE_SAFE)).wait();
    await (await game.setGovernance(timelockAddress)).wait();
  }

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rush: await rush.getAddress(),
    treasury: await treasury.getAddress(),
    game: await game.getAddress(),
    genesisCommit: genesis,
    relayer: relayerAddress,
    devPlayer: player?.address ?? null,
    governance: timelockAddress ?? deployer.address,
    guardian: GOVERNANCE_SAFE ?? deployer.address,
    governanceSafe: GOVERNANCE_SAFE ?? null,
    timelockMinDelay: GOVERNANCE_SAFE ? Number(TIMELOCK_MIN_DELAY) : null,
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
