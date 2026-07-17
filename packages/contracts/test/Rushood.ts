import { expect } from "chai";
import { ethers } from "hardhat";
import type { BaseContract } from "ethers";

const ONE_BILLION = 1_000_000_000n * 10n ** 18n;

/** Lower-cased names of every function in a contract's ABI. */
function functionNames(contract: BaseContract): string[] {
  const names: string[] = [];
  contract.interface.forEachFunction((fn) => names.push(fn.name.toLowerCase()));
  return names;
}

describe("Rushood (RUSH) token", () => {
  async function deploy() {
    const [deployer, distributor, alice, bob] = await ethers.getSigners();
    const Rushood = await ethers.getContractFactory("Rushood");
    const rush = await Rushood.deploy(distributor.address);
    await rush.waitForDeployment();
    return { rush, deployer, distributor, alice, bob };
  }

  describe("metadata & supply", () => {
    it("deploys as RUSHOOD / RUSH with 18 decimals", async () => {
      const { rush } = await deploy();
      expect(await rush.name()).to.equal("RUSHOOD");
      expect(await rush.symbol()).to.equal("RUSH");
      expect(await rush.decimals()).to.equal(18);
    });

    it("mints exactly one billion tokens to the distributor", async () => {
      const { rush, distributor } = await deploy();
      expect(await rush.totalSupply()).to.equal(ONE_BILLION);
      expect(await rush.balanceOf(distributor.address)).to.equal(ONE_BILLION);
    });

    it("exposes MAX_SUPPLY equal to the total supply", async () => {
      const { rush } = await deploy();
      expect(await rush.MAX_SUPPLY()).to.equal(ONE_BILLION);
    });

    it("mints nothing to the deployer", async () => {
      const { rush, deployer } = await deploy();
      expect(await rush.balanceOf(deployer.address)).to.equal(0n);
    });

    it("reverts if the distributor is the zero address", async () => {
      const Rushood = await ethers.getContractFactory("Rushood");
      await expect(Rushood.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Rushood,
        "DistributorIsZeroAddress",
      );
    });
  });

  describe("minting is impossible", () => {
    it("has no mint function in its ABI", async () => {
      const { rush } = await deploy();
      const fns = functionNames(rush);
      expect(fns.some((n) => n.includes("mint"))).to.equal(false);
    });

    it("reverts a raw call to a mint(address,uint256) selector (no such entrypoint)", async () => {
      const { rush, distributor, alice } = await deploy();
      // There is no mint function and no fallback, so a call to the canonical
      // mint selector cannot dispatch — it reverts at the EVM level.
      const data =
        ethers.id("mint(address,uint256)").slice(0, 10) +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(["address", "uint256"], [alice.address, ONE_BILLION])
          .slice(2);
      await expect(
        distributor.sendTransaction({ to: await rush.getAddress(), data }),
      ).to.be.reverted;
      expect(await rush.totalSupply()).to.equal(ONE_BILLION);
    });

    it("keeps total supply constant across transfers", async () => {
      const { rush, distributor, alice } = await deploy();
      await rush.connect(distributor).transfer(alice.address, 1_000n);
      expect(await rush.totalSupply()).to.equal(ONE_BILLION);
    });
  });

  describe("burnable", () => {
    it("burn reduces the holder balance and total supply", async () => {
      const { rush, distributor } = await deploy();
      const amount = 500n * 10n ** 18n;
      await rush.connect(distributor).burn(amount);
      expect(await rush.totalSupply()).to.equal(ONE_BILLION - amount);
      expect(await rush.balanceOf(distributor.address)).to.equal(ONE_BILLION - amount);
    });

    it("burnFrom spends allowance and reduces total supply", async () => {
      const { rush, distributor, alice } = await deploy();
      const amount = 250n * 10n ** 18n;
      await rush.connect(distributor).approve(alice.address, amount);
      await rush.connect(alice).burnFrom(distributor.address, amount);
      expect(await rush.totalSupply()).to.equal(ONE_BILLION - amount);
      expect(await rush.allowance(distributor.address, alice.address)).to.equal(0n);
    });

    it("burnFrom reverts without sufficient allowance", async () => {
      const { rush, distributor, alice } = await deploy();
      await expect(
        rush.connect(alice).burnFrom(distributor.address, 1n),
      ).to.be.revertedWithCustomError(rush, "ERC20InsufficientAllowance");
    });
  });

  describe("no owner / admin / pause", () => {
    it("exposes no ownership, admin, or pause surface", async () => {
      const { rush } = await deploy();
      const fns = functionNames(rush);
      for (const forbidden of ["owner", "transferownership", "pause", "paused", "mint"]) {
        expect(fns).to.not.include(forbidden);
      }
    });
  });
});
