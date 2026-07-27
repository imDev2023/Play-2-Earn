import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Team vesting (#26): the 10% team allocation is locked behind a 6-month cliff and
 * then vests linearly, reaching 100% at month 24 — i.e. 18 months of linear release
 * after the cliff. Months are a fixed 30 days so the schedule is exact and auditable.
 *
 * At the cliff the first 6/24 = 25% unlocks in one step; the remaining 75% streams
 * out over the following 18 months. That is the standard cliff shape (and what
 * OpenZeppelin's VestingWalletCliff implements) — the cliff gates the stream, it
 * does not restart it.
 *
 * Everything here is asserted through the public interface a beneficiary or a token
 * holder could call: releasable / release / released / vestedAmount / start / cliff /
 * duration / end, plus the token balances that actually move.
 */

const DAY = 24n * 60n * 60n;
const MONTH = 30n * DAY;
const CLIFF = 6n * MONTH; // 180 days
const DURATION = 24n * MONTH; // 720 days — cliff + 18 months of linear vesting

const TEAM_ALLOCATION = 100_000_000n * 10n ** 18n; // 10% of the 1B supply

/** Expected vested amount under the cliff+linear schedule at `elapsed` seconds after start. */
function expectedVested(elapsed: bigint): bigint {
  if (elapsed < CLIFF) return 0n;
  if (elapsed >= DURATION) return TEAM_ALLOCATION;
  return (TEAM_ALLOCATION * elapsed) / DURATION;
}

describe("RushoodVesting — team allocation (#26)", () => {
  async function deploy() {
    const [deployer, beneficiary, outsider] = await ethers.getSigners();

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const start = BigInt(await time.latest()) + DAY; // vesting opens tomorrow

    const vesting = await (
      await ethers.getContractFactory("RushoodVesting")
    ).deploy(beneficiary.address, start);

    await rush.transfer(await vesting.getAddress(), TEAM_ALLOCATION);

    const rushAddress = await rush.getAddress();
    return { rush, rushAddress, vesting, start, deployer, beneficiary, outsider };
  }

  describe("schedule shape", () => {
    it("vests over 24 months behind a 6-month cliff", async () => {
      const { vesting, start } = await deploy();
      expect(await vesting.start()).to.equal(start);
      expect(await vesting.duration()).to.equal(DURATION);
      expect(await vesting.cliff()).to.equal(start + CLIFF);
      expect(await vesting.end()).to.equal(start + DURATION);
    });

    it("names the beneficiary as owner", async () => {
      const { vesting, beneficiary } = await deploy();
      expect(await vesting.owner()).to.equal(beneficiary.address);
    });

    it("holds the full team allocation", async () => {
      const { rush, vesting } = await deploy();
      expect(await rush.balanceOf(await vesting.getAddress())).to.equal(TEAM_ALLOCATION);
    });
  });

  describe("the cliff withholds everything until month 6", () => {
    it("has nothing releasable before vesting even starts", async () => {
      const { vesting, rushAddress } = await deploy();
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(0n);
    });

    it("has nothing releasable one second before the cliff", async () => {
      const { vesting, rushAddress, start } = await deploy();
      await time.increaseTo(start + CLIFF - 1n);
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(0n);
    });

    it("keeps the beneficiary at zero even if release is called before the cliff", async () => {
      const { rush, rushAddress, vesting, beneficiary, start } = await deploy();
      await time.increaseTo(start + CLIFF - 100n);

      await vesting["release(address)"](rushAddress);

      expect(await rush.balanceOf(beneficiary.address)).to.equal(0n);
      expect(await vesting["released(address)"](rushAddress)).to.equal(0n);
    });

    it("still holds the entire allocation just before the cliff", async () => {
      const { rush, vesting, start } = await deploy();
      await time.increaseTo(start + CLIFF - 1n);
      expect(await rush.balanceOf(await vesting.getAddress())).to.equal(TEAM_ALLOCATION);
    });
  });

  describe("release after the cliff", () => {
    it("unlocks exactly 25% the moment the cliff lands", async () => {
      const { vesting, rushAddress, start } = await deploy();
      await time.increaseTo(start + CLIFF);
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(TEAM_ALLOCATION / 4n);
    });

    it("pays the cliff tranche to the beneficiary", async () => {
      const { rush, rushAddress, vesting, beneficiary, start } = await deploy();
      await time.setNextBlockTimestamp(start + CLIFF);
      await vesting["release(address)"](rushAddress);

      expect(await rush.balanceOf(beneficiary.address)).to.equal(TEAM_ALLOCATION / 4n);
      expect(await vesting["released(address)"](rushAddress)).to.equal(TEAM_ALLOCATION / 4n);
    });

    it("vests linearly between the cliff and the end", async () => {
      const { vesting, rushAddress, start } = await deploy();
      for (const months of [6n, 9n, 12n, 18n, 23n]) {
        const elapsed = months * MONTH;
        await time.increaseTo(start + elapsed);
        expect(
          await vesting["vestedAmount(address,uint64)"](rushAddress, start + elapsed),
        ).to.equal(expectedVested(elapsed));
      }
    });

    it("reaches 50% at month 12 and 75% at month 18", async () => {
      const { vesting, rushAddress, start } = await deploy();
      await time.increaseTo(start + 12n * MONTH);
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(TEAM_ALLOCATION / 2n);

      await time.increaseTo(start + 18n * MONTH);
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(
        (TEAM_ALLOCATION * 3n) / 4n,
      );
    });

    it("releases the whole allocation once vesting ends", async () => {
      const { rush, rushAddress, vesting, beneficiary, start } = await deploy();
      await time.increaseTo(start + DURATION);
      await vesting["release(address)"](rushAddress);

      expect(await rush.balanceOf(beneficiary.address)).to.equal(TEAM_ALLOCATION);
      expect(await rush.balanceOf(await vesting.getAddress())).to.equal(0n);
    });

    it("never over-releases across repeated partial claims", async () => {
      const { rush, rushAddress, vesting, beneficiary, start } = await deploy();

      for (const months of [6n, 10n, 15n, 21n, 24n]) {
        await time.increaseTo(start + months * MONTH);
        await vesting["release(address)"](rushAddress);
        // Each claim leaves the beneficiary holding exactly what has vested so far.
        const held = await rush.balanceOf(beneficiary.address);
        expect(held).to.be.lessThanOrEqual(TEAM_ALLOCATION);
        expect(held).to.equal(await vesting["released(address)"](rushAddress));
      }

      expect(await rush.balanceOf(beneficiary.address)).to.equal(TEAM_ALLOCATION);
    });

    it("has nothing left to release after a full claim", async () => {
      const { rushAddress, vesting, start } = await deploy();
      await time.increaseTo(start + DURATION + MONTH);
      await vesting["release(address)"](rushAddress);
      expect(await vesting["releasable(address)"](rushAddress)).to.equal(0n);
    });
  });

  describe("who may claim", () => {
    it("lets anyone trigger a release, but only the beneficiary receives it", async () => {
      const { rush, rushAddress, vesting, beneficiary, outsider, start } = await deploy();
      await time.setNextBlockTimestamp(start + 12n * MONTH);

      await vesting.connect(outsider)["release(address)"](rushAddress);

      expect(await rush.balanceOf(outsider.address)).to.equal(0n);
      expect(await rush.balanceOf(beneficiary.address)).to.equal(TEAM_ALLOCATION / 2n);
    });
  });

  describe("construction", () => {
    it("rejects the zero address as beneficiary", async () => {
      const Vesting = await ethers.getContractFactory("RushoodVesting");
      const start = BigInt(await time.latest()) + DAY;
      await expect(Vesting.deploy(ethers.ZeroAddress, start)).to.be.revertedWithCustomError(
        Vesting,
        "OwnableInvalidOwner",
      );
    });
  });
});
