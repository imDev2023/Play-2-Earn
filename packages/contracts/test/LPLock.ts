import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { BaseContract } from "ethers";

/**
 * LP lock (#26): the Uniswap v3 position seeded with the 25% liquidity allocation is
 * custodied here and cannot be moved for 2 years - the "team can't pull liquidity and
 * rug the token" guarantee from the spec.
 *
 * The property that actually matters to a holder is negative: while the lock is live
 * there must be *no* path - not withdrawal, not an approval, not a liquidity
 * decrease - by which the position or its liquidity leaves this contract. Fee
 * collection is the single carve-out, because sweeping fees does not touch liquidity.
 *
 * Driven entirely through the lock's public interface plus the observable owner of the
 * position NFT. Uniswap itself is stood in for by MockNonfungiblePositionManager.
 */

const DAY = 24n * 60n * 60n;
const LOCK = 730n * DAY; // 2 years

const FEES_0 = 1_500n * 10n ** 18n;
const FEES_1 = 3n * 10n ** 18n;

/** Lower-cased names of every function in a contract's ABI. */
function functionNames(contract: BaseContract): string[] {
  const names: string[] = [];
  contract.interface.forEachFunction((fn) => names.push(fn.name.toLowerCase()));
  return names;
}

describe("RushoodLPLock - Uniswap position lock (#26)", () => {
  async function deploy() {
    const [deployer, timelock, treasury, outsider] = await ethers.getSigners();

    // token0/token1 stand in for RUSH and WETH; any two ERC20s exercise the same paths.
    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const weth = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);

    const positionManager = await (
      await ethers.getContractFactory("MockNonfungiblePositionManager")
    ).deploy(await rush.getAddress(), await weth.getAddress());

    const lock = await (
      await ethers.getContractFactory("RushoodLPLock")
    ).deploy(await positionManager.getAddress(), treasury.address, timelock.address);

    // Seed a position and lock it away.
    const tokenId = 1n;
    await positionManager.mintPosition(deployer.address);
    await positionManager
      .connect(deployer)
      .safeTransferFrom(deployer.address, await lock.getAddress(), tokenId);

    const lockedAt = BigInt(await time.latest());

    return {
      rush,
      weth,
      positionManager,
      lock,
      tokenId,
      lockedAt,
      deployer,
      timelock,
      treasury,
      outsider,
    };
  }

  /** Credit the position with fees and fund the position manager to pay them out. */
  async function accrueFees(ctx: Awaited<ReturnType<typeof deploy>>) {
    const pmAddress = await ctx.positionManager.getAddress();
    await ctx.rush.connect(ctx.deployer).transfer(pmAddress, FEES_0);
    await ctx.weth.connect(ctx.deployer).transfer(pmAddress, FEES_1);
    await ctx.positionManager.accrueFees(ctx.tokenId, FEES_0, FEES_1);
  }

  describe("custody", () => {
    it("holds the position NFT once it is deposited", async () => {
      const { positionManager, lock, tokenId } = await deploy();
      expect(await positionManager.ownerOf(tokenId)).to.equal(await lock.getAddress());
    });

    it("locks for two years from deployment", async () => {
      const { lock } = await deploy();
      const unlockTime = await lock.unlockTime();
      const deployedAt = unlockTime - LOCK;
      expect(unlockTime).to.be.greaterThan(BigInt(await time.latest()));
      expect(unlockTime - deployedAt).to.equal(LOCK);
      expect(await lock.LOCK_SECONDS()).to.equal(LOCK);
    });

    it("reports itself as locked until the unlock time", async () => {
      const { lock } = await deploy();
      expect(await lock.isLocked()).to.equal(true);
      await time.increaseTo(await lock.unlockTime());
      expect(await lock.isLocked()).to.equal(false);
    });
  });

  describe("the lock cannot be broken early", () => {
    it("refuses withdrawal one second before unlock", async () => {
      const { lock, timelock, tokenId } = await deploy();
      // setNextBlockTimestamp (not increaseTo) so the withdrawal itself executes at
      // unlockTime - 1; increaseTo would leave the tx landing one second later, on
      // the unlock boundary, and quietly test the wrong instant.
      await time.setNextBlockTimestamp((await lock.unlockTime()) - 1n);
      await expect(
        lock.connect(timelock).withdraw(tokenId, timelock.address),
      ).to.be.revertedWithCustomError(lock, "StillLocked");
    });

    it("refuses withdrawal by the owner immediately after locking", async () => {
      const { lock, timelock, tokenId } = await deploy();
      await expect(
        lock.connect(timelock).withdraw(tokenId, timelock.address),
      ).to.be.revertedWithCustomError(lock, "StillLocked");
    });

    it("still holds the NFT after a rejected withdrawal", async () => {
      const { lock, positionManager, timelock, tokenId } = await deploy();
      await expect(lock.connect(timelock).withdraw(tokenId, timelock.address)).to.be.reverted;
      expect(await positionManager.ownerOf(tokenId)).to.equal(await lock.getAddress());
    });

    it("exposes no way to move the position or its liquidity while locked", async () => {
      const { lock } = await deploy();
      const fns = functionNames(lock);
      // Any of these would defeat the lock: an approval hands the NFT to someone
      // else, and a liquidity decrease drains the pool while keeping the NFT.
      for (const forbidden of [
        "approve",
        "setapprovalforall",
        "decreaseliquidity",
        "transferfrom",
        "safetransferfrom",
        "burn",
        "execute",
        "multicall",
      ]) {
        expect(fns).to.not.include(forbidden);
      }
    });
  });

  describe("withdrawal after the lock expires", () => {
    it("releases the position to the owner once unlocked", async () => {
      const { lock, positionManager, timelock, tokenId } = await deploy();
      await time.increaseTo(await lock.unlockTime());

      await lock.connect(timelock).withdraw(tokenId, timelock.address);

      expect(await positionManager.ownerOf(tokenId)).to.equal(timelock.address);
    });

    it("rejects withdrawal by anyone but the owner", async () => {
      const { lock, outsider, tokenId } = await deploy();
      await time.increaseTo(await lock.unlockTime());
      await expect(
        lock.connect(outsider).withdraw(tokenId, outsider.address),
      ).to.be.revertedWithCustomError(lock, "OwnableUnauthorizedAccount");
    });

    it("emits the withdrawal for public observability", async () => {
      const { lock, timelock, treasury, tokenId } = await deploy();
      await time.increaseTo(await lock.unlockTime());
      await expect(lock.connect(timelock).withdraw(tokenId, treasury.address))
        .to.emit(lock, "PositionWithdrawn")
        .withArgs(tokenId, treasury.address);
    });
  });

  describe("fee collection during the lock", () => {
    it("sweeps accrued fees to the fee recipient while still locked", async () => {
      const ctx = await deploy();
      await accrueFees(ctx);
      const { lock, rush, weth, treasury } = ctx;

      expect(await lock.isLocked()).to.equal(true);
      await lock.collectFees(ctx.tokenId);

      expect(await rush.balanceOf(treasury.address)).to.equal(FEES_0);
      expect(await weth.balanceOf(treasury.address)).to.equal(FEES_1);
    });

    it("is permissionless - anyone may trigger it, only the recipient is paid", async () => {
      const ctx = await deploy();
      await accrueFees(ctx);
      const { lock, rush, outsider, treasury } = ctx;

      await lock.connect(outsider).collectFees(ctx.tokenId);

      expect(await rush.balanceOf(outsider.address)).to.equal(0n);
      expect(await rush.balanceOf(treasury.address)).to.equal(FEES_0);
    });

    it("leaves the position locked in place", async () => {
      const ctx = await deploy();
      await accrueFees(ctx);
      await ctx.lock.collectFees(ctx.tokenId);

      expect(await ctx.positionManager.ownerOf(ctx.tokenId)).to.equal(await ctx.lock.getAddress());
      expect(await ctx.lock.isLocked()).to.equal(true);
    });

    it("emits the amounts collected", async () => {
      const ctx = await deploy();
      await accrueFees(ctx);
      await expect(ctx.lock.collectFees(ctx.tokenId))
        .to.emit(ctx.lock, "FeesCollected")
        .withArgs(ctx.tokenId, FEES_0, FEES_1);
    });
  });

  describe("extending the lock", () => {
    it("lets the owner lengthen the lock", async () => {
      const { lock, timelock } = await deploy();
      const extended = (await lock.unlockTime()) + 365n * DAY;

      await expect(lock.connect(timelock).extendLock(extended)).to.emit(lock, "LockExtended");

      expect(await lock.unlockTime()).to.equal(extended);
    });

    it("refuses to shorten the lock", async () => {
      const { lock, timelock } = await deploy();
      const shortened = (await lock.unlockTime()) - 1n;
      await expect(
        lock.connect(timelock).extendLock(shortened),
      ).to.be.revertedWithCustomError(lock, "LockNotExtended");
    });

    it("rejects extension by anyone but the owner", async () => {
      const { lock, outsider } = await deploy();
      const extended = (await lock.unlockTime()) + DAY;
      await expect(
        lock.connect(outsider).extendLock(extended),
      ).to.be.revertedWithCustomError(lock, "OwnableUnauthorizedAccount");
    });

    it("keeps the position locked past the original unlock time", async () => {
      const { lock, timelock, tokenId } = await deploy();
      const original = await lock.unlockTime();
      await lock.connect(timelock).extendLock(original + 365n * DAY);

      await time.increaseTo(original + DAY);

      expect(await lock.isLocked()).to.equal(true);
      await expect(
        lock.connect(timelock).withdraw(tokenId, timelock.address),
      ).to.be.revertedWithCustomError(lock, "StillLocked");
    });
  });

  describe("construction", () => {
    it("rejects a zero position manager", async () => {
      const [, timelock, treasury] = await ethers.getSigners();
      const Lock = await ethers.getContractFactory("RushoodLPLock");
      await expect(
        Lock.deploy(ethers.ZeroAddress, treasury.address, timelock.address),
      ).to.be.revertedWithCustomError(Lock, "PositionManagerIsZeroAddress");
    });

    it("rejects a zero fee recipient", async () => {
      const [deployer, timelock] = await ethers.getSigners();
      const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
      const pm = await (
        await ethers.getContractFactory("MockNonfungiblePositionManager")
      ).deploy(await rush.getAddress(), await rush.getAddress());

      const Lock = await ethers.getContractFactory("RushoodLPLock");
      await expect(
        Lock.deploy(await pm.getAddress(), ethers.ZeroAddress, timelock.address),
      ).to.be.revertedWithCustomError(Lock, "FeeRecipientIsZeroAddress");
    });
  });
});
