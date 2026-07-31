import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  CANONICAL_V3_POSITION_MANAGERS,
  assertSelfDeployIsWarranted,
  deployUniswapV3Stack,
} from "../scripts/lib/uniswap-v3-stack";
import { POSITION_MANAGER_ABI, seedPoolAndLock } from "../scripts/lib/seed-pool";
import { DEFAULT_FEE_TIER, fullRangeTicks } from "../scripts/lib/uniswap-price";

/**
 * Standing up Uniswap v3 ourselves (#26).
 *
 * Robinhood Chain testnet 46630 has no Uniswap v3 - the published deployments cover
 * mainnet 4663 only, and `eth_getCode` at every mainnet address on 46630 comes back
 * empty. So the launch rehearsal has to bring its own factory and position manager.
 *
 * The point of these tests is that the stack we stand up is a *real* Uniswap, not a
 * second mock wearing its name. The mocked seeding tests in SeedPool.ts prove the
 * plumbing; these prove the plumbing works against the actual AMM - a real pool at a
 * real address, holding real balances, minted through the real position manager.
 */

const RUSH_SEED = 500_000_000n * 10n ** 18n;
const ETH_SEED = 50n * 10n ** 18n;

describe("Uniswap v3 stack for chains without one (#26)", () => {
  async function deployStack() {
    const [deployer, timelock, feeRecipient] = await ethers.getSigners();

    const weth9 = await (await ethers.getContractFactory("WETH9")).deploy();
    await weth9.waitForDeployment();

    const stack = await deployUniswapV3Stack(deployer, { weth9: await weth9.getAddress() });

    return { stack, weth9, deployer, timelock, feeRecipient };
  }

  describe("the deployed stack", () => {
    it("wires the position manager to the factory and WETH9 it was given", async () => {
      const { stack, weth9 } = await deployStack();

      const manager = new ethers.Contract(
        stack.positionManager,
        ["function factory() view returns (address)", "function WETH9() view returns (address)"],
        ethers.provider,
      );

      expect(await manager.factory()).to.equal(stack.factory);
      expect(await manager.WETH9()).to.equal(await weth9.getAddress());
    });

    it("enables the three canonical fee tiers", async () => {
      const { stack } = await deployStack();

      const factory = new ethers.Contract(
        stack.factory,
        ["function feeAmountTickSpacing(uint24) view returns (int24)"],
        ethers.provider,
      );

      expect(await factory.feeAmountTickSpacing(500)).to.equal(10n);
      expect(await factory.feeAmountTickSpacing(3000)).to.equal(60n);
      expect(await factory.feeAmountTickSpacing(10000)).to.equal(200n);
    });

    /**
     * The periphery addresses pools by CREATE2, using a pool init-code hash baked in at
     * *compile* time. Deploying a factory built from different source - even a faithful
     * one - makes every address the position manager computes point at nothing, and the
     * failure surfaces as an unhelpful revert deep inside a mint. Using Uniswap's own
     * published artifacts is what keeps the two in agreement, so it is worth asserting.
     */
    it("produces pools at the addresses the position manager computes", async () => {
      const { stack, weth9, deployer } = await deployStack();

      const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
      const [tokenA, tokenB] = [await rush.getAddress(), await weth9.getAddress()];
      const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

      const manager = new ethers.Contract(
        stack.positionManager,
        [
          "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
        ],
        deployer,
      );
      await (
        await manager.createAndInitializePoolIfNecessary(token0, token1, 3000, 2n ** 96n)
      ).wait();

      const factory = new ethers.Contract(
        stack.factory,
        ["function getPool(address,address,uint24) view returns (address)"],
        ethers.provider,
      );
      const pool = await factory.getPool(token0, token1, 3000);

      expect(pool).to.not.equal(ethers.ZeroAddress);
      expect(await ethers.provider.getCode(pool)).to.not.equal("0x");
    });
  });

  describe("WETH9", () => {
    it("wraps ETH one-for-one", async () => {
      const { weth9, deployer } = await deployStack();

      await (await weth9.deposit({ value: 10n ** 18n })).wait();

      expect(await weth9.balanceOf(deployer.address)).to.equal(10n ** 18n);
    });

    /** The invariant that makes it wrapped ETH rather than just an ERC20 called WETH. */
    it("holds exactly one ETH of backing per token in supply", async () => {
      const { weth9 } = await deployStack();

      await (await weth9.deposit({ value: 3n * 10n ** 18n })).wait();

      const address = await weth9.getAddress();
      expect(await ethers.provider.getBalance(address)).to.equal(await weth9.totalSupply());
    });

    it("unwraps back to ETH and burns the supply", async () => {
      const { weth9, deployer } = await deployStack();

      await (await weth9.deposit({ value: 2n * 10n ** 18n })).wait();
      await (await weth9.withdraw(2n * 10n ** 18n)).wait();

      expect(await weth9.totalSupply()).to.equal(0n);
      expect(await weth9.balanceOf(deployer.address)).to.equal(0n);
    });

    it("refuses to unwrap more than the caller holds", async () => {
      const { weth9, timelock } = await deployStack();

      await expect(weth9.connect(timelock).withdraw(1n)).to.be.reverted;
    });
  });

  /**
   * The whole reason for standing this up: proving the launch seeding flow works against
   * real Uniswap. SeedPool.ts runs the same function against a mock, which cannot catch a
   * disagreement about tick spacing, price encoding or the position-manager ABI.
   */
  describe("seeding the launch pool against the real AMM", () => {
    async function seedAgainstRealUniswap() {
      const ctx = await deployStack();

      const rush = await (
        await ethers.getContractFactory("Rushood")
      ).deploy(ctx.deployer.address);
      const lock = await (
        await ethers.getContractFactory("RushoodLPLock")
      ).deploy(ctx.stack.positionManager, ctx.feeRecipient.address, ctx.timelock.address);

      // The same ABI the deploy script binds to - restating it here would let the two
      // drift apart silently, which is the coincidence seed-pool.ts warns about.
      const manager = new ethers.Contract(
        ctx.stack.positionManager,
        [...POSITION_MANAGER_ABI],
        ctx.deployer,
      );

      const result = await seedPoolAndLock({
        positionManager: manager as never,
        rush: rush as never,
        weth: ctx.weth9 as never,
        recipient: await lock.getAddress(),
        rushAmount: RUSH_SEED,
        ethAmount: ETH_SEED,
        now: BigInt(await time.latest()),
      });

      return { ...ctx, rush, lock, manager, result };
    }

    it("mints the position straight into the lock", async () => {
      const { manager, lock, result } = await seedAgainstRealUniswap();

      expect(await manager.ownerOf(result.tokenId)).to.equal(await lock.getAddress());
    });

    it("leaves the real pool holding the seeded liquidity", async () => {
      const { stack, rush, weth9, result } = await seedAgainstRealUniswap();

      const factory = new ethers.Contract(
        stack.factory,
        ["function getPool(address,address,uint24) view returns (address)"],
        ethers.provider,
      );
      const pool = await factory.getPool(result.params.token0, result.params.token1, DEFAULT_FEE_TIER);

      // Full-range liquidity on a fresh pool consumes essentially all of both sides; the
      // pool is what ends up holding them, not the position manager.
      expect(await rush.balanceOf(pool)).to.be.greaterThan((RUSH_SEED * 99n) / 100n);
      expect(await weth9.balanceOf(pool)).to.be.greaterThan((ETH_SEED * 99n) / 100n);
    });

    it("opens the pool at the pinned price", async () => {
      const { stack, result } = await seedAgainstRealUniswap();

      const factory = new ethers.Contract(
        stack.factory,
        ["function getPool(address,address,uint24) view returns (address)"],
        ethers.provider,
      );
      const pool = new ethers.Contract(
        await factory.getPool(result.params.token0, result.params.token1, DEFAULT_FEE_TIER),
        ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"],
        ethers.provider,
      );

      expect((await pool.slot0()).sqrtPriceX96).to.equal(result.params.sqrtPriceX96);
    });

    it("seeds the full range at the intended tick spacing", async () => {
      const { stack, result } = await seedAgainstRealUniswap();

      const expected = fullRangeTicks(DEFAULT_FEE_TIER);
      const manager = new ethers.Contract(
        stack.positionManager,
        [
          "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
        ],
        ethers.provider,
      );
      const position = await manager.positions(result.tokenId);

      expect(position.fee).to.equal(BigInt(DEFAULT_FEE_TIER));
      expect(position.tickLower).to.equal(BigInt(expected.tickLower));
      expect(position.tickUpper).to.equal(BigInt(expected.tickUpper));
      expect(position.liquidity).to.be.greaterThan(0n);
    });
  });

  /**
   * Deploying a second factory on a chain that already has Uniswap would create a pool
   * no aggregator, router or price feed looks at - a launch that appears seeded but is
   * invisible. On mainnet 4663 that is the difference between a real listing and a
   * silent one, so the script refuses rather than warns.
   */
  describe("refusing to shadow a canonical deployment", () => {
    it("refuses on Robinhood mainnet, which already has Uniswap v3", () => {
      expect(() => assertSelfDeployIsWarranted(4663n)).to.throw(/already has Uniswap v3/);
    });

    it("names the canonical position manager so the caller can use it instead", () => {
      expect(() => assertSelfDeployIsWarranted(4663n)).to.throw(
        CANONICAL_V3_POSITION_MANAGERS[4663],
      );
    });

    it("allows the testnet, which does not", () => {
      expect(() => assertSelfDeployIsWarranted(46630n)).to.not.throw();
    });
  });
});
