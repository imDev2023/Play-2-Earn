import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import {
  EXPECTED_FEE_TIERS,
  type UniswapV3Stack,
  assertSelfDeployIsWarranted,
  deployUniswapV3Stack,
} from "./lib/uniswap-v3-stack";

/**
 * Stand up Uniswap v3 on a chain that lacks one (#26).
 *
 *   npx hardhat run scripts/deploy-uniswap-v3.ts --network robinhoodTestnet
 *
 * Robinhood Chain testnet 46630 has no Uniswap v3, so the launch rehearsal has no pool
 * to seed and `deploy-launch.ts` — which refuses to guess a position manager — has
 * nothing to point at. This script fills that gap and prints the two environment
 * variables the launch deploy needs.
 *
 * It is *not* part of the mainnet launch: 4663 has a canonical Uniswap, and this script
 * refuses to run there rather than shadow it.
 *
 * Writes deployments/uniswap-<network>.json and re-uses it on a second run, so a failed
 * launch deploy can be retried without paying for another factory or — worse — silently
 * seeding into a second, different pool.
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  assertSelfDeployIsWarranted(chainId);

  const dir = join(__dirname, "..", "deployments");
  const path = join(dir, `uniswap-${network.name}.json`);

  const existing = await loadIfStillDeployed(path);
  if (existing) {
    console.log(`Uniswap v3 already stood up on ${network.name} — reusing.`);
    printLaunchEnv(existing);
    return;
  }

  console.log(`Deploying Uniswap v3 on ${network.name} (chain ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  console.log(`  balance   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // WETH first, so the position manager can be given its address. An existing canonical
  // wrapper wins if one is named — this only deploys because 46630 has none whose
  // behaviour we can vouch for.
  const configuredWeth = process.env.WETH_ADDRESS;
  let weth9: string;
  if (configuredWeth) {
    if ((await ethers.provider.getCode(configuredWeth)) === "0x") {
      throw new Error(`WETH_ADDRESS ${configuredWeth} has no code on ${network.name}`);
    }
    weth9 = configuredWeth;
    console.log(`  WETH9                 ${weth9}  (existing, from WETH_ADDRESS)`);
  } else {
    const deployed = await (await ethers.getContractFactory("WETH9")).deploy();
    await deployed.waitForDeployment();
    weth9 = await deployed.getAddress();
    console.log(`  WETH9                 ${weth9}  (deployed)`);
  }

  const stack = await deployUniswapV3Stack(deployer, {
    weth9,
    nativeCurrencyLabel: process.env.NATIVE_CURRENCY_LABEL ?? "ETH",
  });

  console.log(`  UniswapV3Factory      ${stack.factory}`);
  console.log(`  NFTDescriptor         ${stack.nftDescriptorLibrary}`);
  console.log(`  PositionDescriptor    ${stack.positionDescriptor}`);
  console.log(`  PositionManager       ${stack.positionManager}`);

  await assertStackIsLive(stack);

  const record = { network: network.name, chainId: Number(chainId), deployer: deployer.address, ...stack };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nWritten to deployments/uniswap-${network.name}.json`);

  printLaunchEnv(record);
}

/**
 * Confirm the stack actually works before anything is asked to seed into it.
 *
 * A deploy that succeeds transactionally can still be unusable — a mislinked descriptor
 * or a factory/periphery mismatch only surfaces when a mint reverts. Checking here means
 * the failure lands in this script rather than halfway through the launch sequence, with
 * the genesis allocation already distributed.
 */
async function assertStackIsLive(stack: UniswapV3Stack): Promise<void> {
  const factory = new ethers.Contract(
    stack.factory,
    ["function feeAmountTickSpacing(uint24) view returns (int24)"],
    ethers.provider,
  );
  for (const tier of EXPECTED_FEE_TIERS) {
    const spacing = await factory.feeAmountTickSpacing(tier);
    if (spacing === 0n) throw new Error(`Factory did not enable the ${tier} fee tier`);
  }

  const manager = new ethers.Contract(
    stack.positionManager,
    ["function factory() view returns (address)", "function WETH9() view returns (address)"],
    ethers.provider,
  );
  const wired = await manager.factory();
  if (wired.toLowerCase() !== stack.factory.toLowerCase()) {
    throw new Error(`Position manager points at factory ${wired}, expected ${stack.factory}`);
  }
  const wiredWeth = await manager.WETH9();
  if (wiredWeth.toLowerCase() !== stack.weth9.toLowerCase()) {
    throw new Error(`Position manager points at WETH ${wiredWeth}, expected ${stack.weth9}`);
  }

  console.log("\n  (fee tiers enabled and position manager wiring verified on-chain)");
}

/** Re-use a previous run only if its addresses still have code on this chain. */
async function loadIfStillDeployed(
  path: string,
): Promise<{ factory: string; positionManager: string; weth9: string; [k: string]: unknown } | null> {
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["factory", "positionManager", "weth9"]) {
    if ((await ethers.provider.getCode(record[key])) === "0x") return null;
  }
  return record;
}

function printLaunchEnv(record: { positionManager: string; weth9: string }): void {
  console.log("\nSet these for the launch deploy:");
  console.log(`  UNISWAP_POSITION_MANAGER=${record.positionManager}`);
  console.log(`  WETH_ADDRESS=${record.weth9}`);
  console.log(
    "\nNOTE: this is a self-deployed Uniswap v3, not a canonical one. Pools created here\n" +
      "      are not indexed by any router, aggregator or price feed on this chain.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
