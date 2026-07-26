import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";
import { epochChain } from "./lib/relayer-core";
import { allocations, distributeGenesis, type GenesisDestinations } from "./lib/genesis";
import { POSITION_MANAGER_ABI, WETH_ABI, seedPoolAndLock } from "./lib/seed-pool";
import { DEFAULT_FEE_TIER } from "./lib/uniswap-price";

/**
 * The full launch deployment (#26, spec §10): token, governance, game, vesting, LP lock,
 * genesis allocation, and a seeded-then-locked Uniswap position.
 *
 *   npx hardhat run scripts/deploy-launch.ts --network robinhoodTestnet
 *
 * Unlike deploy-skeleton.ts (a dev-convenience stack), this is the sequence that runs
 * at launch, and it runs once. Everything it decides is either pinned as a constant
 * here or read from the environment — nothing is derived from whatever happens to be
 * lying around in the local node.
 *
 * Writes deployments/<network>.json for the relayer, the frontend, and the published
 * address list.
 */

// ---------------------------------------------------------------------------
// Launch parameters
// ---------------------------------------------------------------------------

/**
 * The pinned opening price: 1e-7 ETH per RUSH, expressed as RUSH per ETH so it stays
 * an exact integer. Both tokens have 18 decimals, so this ratio applies directly to
 * their wei amounts.
 *
 * The ETH side is the only knob (LP_ETH_AMOUNT) — the RUSH side is derived from it, so
 * seeding a smaller pool scales both sides together and opens at the same price rather
 * than a cheaper one. That is what makes a scaled-down testnet pool a faithful
 * rehearsal of the mainnet one.
 */
const RUSH_PER_ETH = 10_000_000n;

/** Full mainnet seed: 25 ETH against the 250,000,000 RUSH liquidity allocation. */
const DEFAULT_LP_ETH_MAINNET = 25n * 10n ** 18n;
/** Testnet rehearsal seed — same price, a fraction of the capital. */
const DEFAULT_LP_ETH_TESTNET = 5n * 10n ** 16n; // 0.05 ETH

const TIMELOCK_MIN_DELAY = BigInt(process.env.TIMELOCK_MIN_DELAY ?? 2 * 24 * 60 * 60);
const CHAIN_LENGTH = Number(process.env.RELAYER_CHAIN_LENGTH ?? DEFAULT_CHAIN_LENGTH);
const LP_FEE_TIER = Number(process.env.LP_FEE_TIER ?? DEFAULT_FEE_TIER);

const MAINNET_CHAIN_ID = 4663n;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for a launch deployment`);
  return value;
}

/**
 * The relayer's master seed — the crown-jewel secret.
 *
 * On a public network this MUST come from the environment. `DEFAULT_MASTER_SEED` is
 * the committed dev seed ("rushood-dev-seed"), and the whole reveal chain is derived
 * from it deterministically. Falling back to it on a real chain would publish a genesis
 * commitment anyone could reproduce, making every future roll predictable in advance —
 * the exact failure the commit-reveal scheme exists to prevent. Spec §8: "treat s₀ as
 * the crown-jewel secret".
 *
 * deploy-skeleton.ts may fall back, because it only ever targets a local node.
 */
function resolveMasterSeed(isLocal: boolean): string {
  if (isLocal) return process.env.RELAYER_SEED ?? DEFAULT_MASTER_SEED;

  const seed = requireEnv("RELAYER_SEED");
  if (seed === DEFAULT_MASTER_SEED) {
    throw new Error(
      "RELAYER_SEED is set to the public dev seed. Every roll derived from it is " +
        "predictable — generate a secret seed for this deployment.",
    );
  }
  return seed;
}

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, relayerSigner] = signers;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  const masterSeed = resolveMasterSeed(isLocal);

  // On a real network every role must be named explicitly. Locally we fall back to
  // dev signers so the dry run is a single command.
  const safe = isLocal
    ? (signers[3] ?? deployer).address
    : (process.env.GOVERNANCE_SAFE ?? requireEnv("GOVERNANCE_SAFE"));
  const teamBeneficiary = isLocal
    ? (signers[4] ?? deployer).address
    : (process.env.TEAM_BENEFICIARY ?? requireEnv("TEAM_BENEFICIARY"));
  const relayerAddress = process.env.RELAYER_ADDRESS ?? (relayerSigner ?? deployer).address;

  const lpEthAmount = BigInt(
    process.env.LP_ETH_AMOUNT ??
      (chainId === MAINNET_CHAIN_ID ? DEFAULT_LP_ETH_MAINNET : DEFAULT_LP_ETH_TESTNET),
  );
  const lpRushAmount = lpEthAmount * RUSH_PER_ETH;
  const liquidityBudget = allocations().liquidity;
  if (lpRushAmount > liquidityBudget) {
    throw new Error(
      `Seeding ${lpRushAmount} RUSH exceeds the ${liquidityBudget} liquidity allocation — ` +
        `lower LP_ETH_AMOUNT (max ${liquidityBudget / RUSH_PER_ETH} wei of ETH at the pinned price)`,
    );
  }

  console.log(`Launch deployment on ${network.name} (chain ${chainId})`);
  console.log(`  deployer         ${deployer.address}`);
  console.log(`  safe / guardian  ${safe}`);
  console.log(`  team beneficiary ${teamBeneficiary}`);
  console.log(`  relayer          ${relayerAddress}`);

  // --- 1. Token -----------------------------------------------------------
  const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
  await rush.waitForDeployment();

  // --- 2. Governance ------------------------------------------------------
  const timelock = await (await ethers.getContractFactory("RushoodTimelock")).deploy(
    TIMELOCK_MIN_DELAY,
    [safe],
    [safe],
    ethers.ZeroAddress,
  );
  await timelock.waitForDeployment();

  // --- 3. Treasury + game + randomness ------------------------------------
  const genesisCommit = epochChain(masterSeed, 0, CHAIN_LENGTH)[0];
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
    await rush.getAddress(),
  );
  await treasury.waitForDeployment();

  const game = await (await ethers.getContractFactory("RushoodGame")).deploy(
    await rush.getAddress(),
    await treasury.getAddress(),
    genesisCommit,
    relayerAddress,
  );
  await game.waitForDeployment();
  await (await treasury.setGame(await game.getAddress())).wait();

  // --- 4. Vesting + LP lock ------------------------------------------------
  const vestingStart = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const vesting = await (
    await ethers.getContractFactory("RushoodVesting")
  ).deploy(teamBeneficiary, vestingStart);
  await vesting.waitForDeployment();

  const { positionManagerAddress, wethAddress, usingMocks } = await resolveUniswap(isLocal, rush);

  // Fees go to the Safe, NOT the Treasury. Treasury only ever moves its immutable RUSH
  // token and has no rescue path, so the WETH side of the LP fees would be stuck there
  // forever. Routing LP fee income into the house bankroll would also be an economics
  // change the spec doesn't describe — the Safe can hold both sides and decide.
  const lpLock = await (
    await ethers.getContractFactory("RushoodLPLock")
  ).deploy(positionManagerAddress, safe, await timelock.getAddress());
  await lpLock.waitForDeployment();

  // --- 5. Genesis allocation ----------------------------------------------
  // Liquidity lands on the deployer, which seeds the pool in the next step; any
  // unseeded remainder is handed to the Safe below.
  const destinations: GenesisDestinations = {
    treasury: await treasury.getAddress(),
    liquidity: deployer.address,
    community: safe,
    team: await vesting.getAddress(),
    staking: safe,
  };
  const sent = await distributeGenesis(rush as never, deployer.address, destinations);
  console.log("\nGenesis allocation transferred:");
  for (const [bucket, amount] of Object.entries(sent)) {
    console.log(`  ${bucket.padEnd(10)} ${ethers.formatUnits(amount, 18).padStart(18)} RUSH`);
  }

  // Verify the split landed *here*, at the one moment the balances are still exactly
  // the allocation. After this the game starts moving RUSH — stakes into the treasury,
  // burns out of the supply — so this is the last point at which exact equality is the
  // right assertion rather than an invariant.
  // Buckets are aggregated by address first: community and staking share the Safe, so
  // checking each bucket against that address's balance in isolation would fail on a
  // correct distribution.
  const expectedByAddress = new Map<string, bigint>();
  for (const [bucket, amount] of Object.entries(sent)) {
    const destination = destinations[bucket as keyof typeof destinations].toLowerCase();
    expectedByAddress.set(destination, (expectedByAddress.get(destination) ?? 0n) + amount);
  }
  for (const [destination, amount] of expectedByAddress) {
    const balance = await rush.balanceOf(destination);
    if (balance !== amount) {
      throw new Error(
        `Genesis verification failed: ${destination} holds ${balance}, expected ${amount}`,
      );
    }
  }
  console.log("  (verified on-chain)");

  // --- 6. Seed the pool and lock the position ------------------------------
  const weth = new ethers.Contract(wethAddress, [...WETH_ABI], deployer);
  const positionManager = new ethers.Contract(
    positionManagerAddress,
    [...POSITION_MANAGER_ABI],
    deployer,
  );

  const { tokenId, params } = await seedPoolAndLock({
    positionManager: positionManager as never,
    rush: rush as never,
    weth: weth as never,
    recipient: await lpLock.getAddress(),
    rushAmount: lpRushAmount,
    ethAmount: lpEthAmount,
    feeTier: LP_FEE_TIER,
    now: BigInt((await ethers.provider.getBlock("latest"))!.timestamp),
  });

  const unseeded = liquidityBudget - lpRushAmount;
  if (unseeded > 0n && !isLocal && process.env.ALLOW_PARTIAL_LP_SEED !== "true") {
    throw new Error(
      `Only ${lpRushAmount} of the ${liquidityBudget} RUSH liquidity allocation would be ` +
        `seeded, leaving ${unseeded} RUSH outside the LP lock. The spec locks the full 25% ` +
        `(§3). Raise LP_ETH_AMOUNT to seed it all, or set ALLOW_PARTIAL_LP_SEED=true to ` +
        `accept the overhang deliberately.`,
    );
  }
  if (unseeded > 0n) {
    await (await rush.transfer(safe, unseeded)).wait();
    console.log(
      `\n!! ${ethers.formatUnits(unseeded, 18)} RUSH of the liquidity allocation was NOT seeded.\n` +
        `   It now sits with the Safe (${safe}) and is OUTSIDE the LP lock — a visible\n` +
        `   overhang. Seed it later or move it somewhere holders can see it committed.`,
    );
  }

  // --- 7. Hand governance the sensitive roles ------------------------------
  await (await game.setGuardian(safe)).wait();
  await (await game.setGovernance(await timelock.getAddress())).wait();

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    // Recorded because verification must replay the exact constructor arguments.
    deployer: deployer.address,
    rush: await rush.getAddress(),
    treasury: await treasury.getAddress(),
    game: await game.getAddress(),
    vesting: await vesting.getAddress(),
    lpLock: await lpLock.getAddress(),
    timelock: await timelock.getAddress(),
    genesisCommit,
    relayer: relayerAddress,
    governance: await timelock.getAddress(),
    guardian: safe,
    governanceSafe: safe,
    timelockMinDelay: Number(TIMELOCK_MIN_DELAY),
    teamBeneficiary,
    vestingStart: Number(vestingStart),
    lpPositionId: Number(tokenId),
    lpUnlockTime: Number(await lpLock.unlockTime()),
    lpFeeRecipient: safe,
    lpPool: {
      positionManager: positionManagerAddress,
      weth: wethAddress,
      usingMocks,
      feeTier: params.fee,
      token0: params.token0,
      token1: params.token1,
      amount0: params.amount0.toString(),
      amount1: params.amount1.toString(),
      sqrtPriceX96: params.sqrtPriceX96.toString(),
      rushSeeded: lpRushAmount.toString(),
      ethSeeded: lpEthAmount.toString(),
      unseededRush: unseeded.toString(),
    },
  };

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${network.name}.json`), JSON.stringify(deployment, null, 2) + "\n");

  console.log("\nLaunch stack deployed:");
  console.table({
    rush: deployment.rush,
    treasury: deployment.treasury,
    game: deployment.game,
    vesting: deployment.vesting,
    lpLock: deployment.lpLock,
    timelock: deployment.timelock,
  });
  console.log(`\nLP position #${tokenId} locked until ${new Date(deployment.lpUnlockTime * 1000).toISOString()}`);
  console.log(`Deployment written to deployments/${network.name}.json`);

  if (usingMocks) {
    console.log(
      "\n!! Uniswap was MOCKED for this run. This is a rehearsal, not a real pool —\n" +
        "   set UNISWAP_POSITION_MANAGER and WETH_ADDRESS to seed real liquidity.",
    );
  }
}

/**
 * Find the Uniswap position manager and WETH to seed against.
 *
 * On a real network both must be given explicitly — guessing an address here would
 * mean seeding the launch liquidity into whatever contract happened to answer. Locally,
 * mocks are deployed so the whole sequence can be rehearsed in one command.
 */
async function resolveUniswap(
  isLocal: boolean,
  rush: { getAddress(): Promise<string> },
): Promise<{ positionManagerAddress: string; wethAddress: string; usingMocks: boolean }> {
  const configuredManager = process.env.UNISWAP_POSITION_MANAGER;
  const configuredWeth = process.env.WETH_ADDRESS;

  if (configuredManager && configuredWeth) {
    return {
      positionManagerAddress: configuredManager,
      wethAddress: configuredWeth,
      usingMocks: false,
    };
  }

  if (!isLocal) {
    throw new Error(
      "UNISWAP_POSITION_MANAGER and WETH_ADDRESS must both be set on a public network. " +
        "Robinhood Chain's Uniswap v3 deployment addresses are at developers.uniswap.org; " +
        "if v3 is not deployed on this chain yet, seed the pool manually and skip this script.",
    );
  }

  const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
  await weth.waitForDeployment();
  const positionManager = await (
    await ethers.getContractFactory("MockNonfungiblePositionManager")
  ).deploy(await rush.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  return {
    positionManagerAddress: await positionManager.getAddress(),
    wethAddress: await weth.getAddress(),
    usingMocks: true,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
