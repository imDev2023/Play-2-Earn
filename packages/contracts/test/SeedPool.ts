import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { seedPoolAndLock } from "../scripts/lib/seed-pool";
import { DEFAULT_FEE_TIER, fullRangeTicks } from "../scripts/lib/uniswap-price";
import { allocations } from "../scripts/lib/genesis";

/**
 * LP seeding and locking (#26, spec §10.5), driven end-to-end against a mocked position
 * manager.
 *
 * What matters here is the plumbing around the pool, not the AMM maths: that the
 * liquidity allocation and the ETH both actually leave the deployer, that the price the
 * pool is initialized at is the one that was intended, and — the part holders care
 * about — that the position NFT is never held by an EOA on its way into the lock.
 */

const RUSH_SEED = allocations().liquidity; // 250,000,000 RUSH
const ETH_SEED = 25n * 10n ** 18n;
const Q96 = 2n ** 96n;

describe("LP seeding and locking (#26)", () => {
  async function deploy() {
    const [deployer, timelock, treasury] = await ethers.getSigners();

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
    const positionManager = await (
      await ethers.getContractFactory("MockNonfungiblePositionManager")
    ).deploy(await rush.getAddress(), await weth.getAddress());

    const lock = await (
      await ethers.getContractFactory("RushoodLPLock")
    ).deploy(await positionManager.getAddress(), treasury.address, timelock.address);

    return { rush, weth, positionManager, lock, deployer, timelock, treasury };
  }

  async function seed(ctx: Awaited<ReturnType<typeof deploy>>) {
    return seedPoolAndLock({
      positionManager: ctx.positionManager as never,
      rush: ctx.rush as never,
      weth: ctx.weth as never,
      recipient: await ctx.lock.getAddress(),
      rushAmount: RUSH_SEED,
      ethAmount: ETH_SEED,
      now: BigInt(await time.latest()),
    });
  }

  it("mints the position directly into the lock", async () => {
    const ctx = await deploy();
    const { tokenId } = await seed(ctx);

    expect(await ctx.positionManager.ownerOf(tokenId)).to.equal(await ctx.lock.getAddress());
  });

  it("never leaves the position with the deployer", async () => {
    const ctx = await deploy();
    const { tokenId } = await seed(ctx);

    expect(await ctx.positionManager.ownerOf(tokenId)).to.not.equal(ctx.deployer.address);
  });

  it("moves the full liquidity allocation into the pool", async () => {
    const ctx = await deploy();
    await seed(ctx);

    expect(await ctx.rush.balanceOf(await ctx.positionManager.getAddress())).to.equal(RUSH_SEED);
  });

  it("wraps and deposits the full ETH side", async () => {
    const ctx = await deploy();
    await seed(ctx);

    expect(await ctx.weth.balanceOf(await ctx.positionManager.getAddress())).to.equal(ETH_SEED);
  });

  it("initializes the pool at the intended price, not its inverse", async () => {
    const ctx = await deploy();
    const { params } = await seed(ctx);

    const sqrtPriceX96 = await ctx.positionManager.lastSqrtPriceX96();
    expect(sqrtPriceX96).to.equal(params.sqrtPriceX96);

    // Decode back to token1-per-token0 and confirm it describes the deposited amounts.
    const priceScaled = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96);
    const expectedScaled = (params.amount1 * 10n ** 18n) / params.amount0;
    const drift = priceScaled > expectedScaled ? priceScaled - expectedScaled : expectedScaled - priceScaled;
    expect(drift * 10n ** 9n <= expectedScaled).to.equal(true);
  });

  it("pairs each token with its own amount whichever way the addresses sort", async () => {
    const ctx = await deploy();
    const { params, rushAddress, wethAddress } = await seed(ctx);

    const rushIsToken0 = rushAddress.toLowerCase() < wethAddress.toLowerCase();
    expect(params.token0).to.equal(rushIsToken0 ? rushAddress : wethAddress);
    expect(rushIsToken0 ? params.amount0 : params.amount1).to.equal(RUSH_SEED);
    expect(rushIsToken0 ? params.amount1 : params.amount0).to.equal(ETH_SEED);
  });

  it("seeds across the full price range at the default fee tier", async () => {
    const ctx = await deploy();
    await seed(ctx);

    const minted = await ctx.positionManager.lastMintParams();
    const expected = fullRangeTicks(DEFAULT_FEE_TIER);
    expect(minted.fee).to.equal(DEFAULT_FEE_TIER);
    expect(minted.tickLower).to.equal(BigInt(expected.tickLower));
    expect(minted.tickUpper).to.equal(BigInt(expected.tickUpper));
  });

  it("leaves the seeded position locked", async () => {
    const ctx = await deploy();
    const { tokenId } = await seed(ctx);

    expect(await ctx.lock.isLocked()).to.equal(true);
    await expect(
      ctx.lock.connect(ctx.timelock).withdraw(tokenId, ctx.timelock.address),
    ).to.be.revertedWithCustomError(ctx.lock, "StillLocked");
  });

  it("releases the position only after the two-year lock expires", async () => {
    const ctx = await deploy();
    const { tokenId } = await seed(ctx);

    await time.increaseTo(await ctx.lock.unlockTime());
    await ctx.lock.connect(ctx.timelock).withdraw(tokenId, ctx.timelock.address);

    expect(await ctx.positionManager.ownerOf(tokenId)).to.equal(ctx.timelock.address);
  });
});
