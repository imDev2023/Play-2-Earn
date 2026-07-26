import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  GENESIS_ALLOCATION,
  GENESIS_BUCKETS,
  MAX_SUPPLY,
  allocationOf,
  allocationTotal,
  allocations,
  distributeGenesis,
} from "../scripts/lib/genesis";

/**
 * Genesis allocation (#26, spec §3): the fixed 1B supply splits 45/25/15/10/5 across
 * treasury, liquidity, community, team and staking.
 *
 * This is a one-shot, irreversible mainnet transaction, so the tests assert both the
 * arithmetic (the five buckets consume the supply exactly, no dust stranded on the
 * deployer) and the on-chain outcome (every bucket's tokens actually land at the right
 * address, observed through ERC20 balances).
 */

const PERCENT_OF_SUPPLY = {
  treasury: 45n,
  liquidity: 25n,
  community: 15n,
  team: 10n,
  staking: 5n,
} as const;

describe("Genesis allocation (#26)", () => {
  describe("the split", () => {
    it("matches the spec's 45/25/15/10/5", async () => {
      for (const [bucket, percent] of Object.entries(PERCENT_OF_SUPPLY)) {
        expect(allocationOf(bucket as keyof typeof PERCENT_OF_SUPPLY)).to.equal(
          (MAX_SUPPLY * percent) / 100n,
        );
      }
    });

    it("consumes the entire supply with nothing left over", async () => {
      expect(allocationTotal()).to.equal(MAX_SUPPLY);
    });

    it("adds up to 10,000 basis points", async () => {
      const totalBps = GENESIS_BUCKETS.reduce(
        (sum, bucket) => sum + GENESIS_ALLOCATION[bucket].bps,
        0n,
      );
      expect(totalBps).to.equal(10_000n);
    });

    it("gives the team exactly 100,000,000 RUSH", async () => {
      expect(allocations().team).to.equal(100_000_000n * 10n ** 18n);
    });

    it("gives liquidity exactly 250,000,000 RUSH", async () => {
      expect(allocations().liquidity).to.equal(250_000_000n * 10n ** 18n);
    });
  });

  describe("distribution on-chain", () => {
    /**
     * Every bucket gets a distinct destination so each balance assertion is
     * unambiguous — treasury and team go to the real contracts that will hold them in
     * production, the rest to separate signers standing in for the Safe.
     */
    async function deployStack() {
      const [deployer, community, staking, teamBeneficiary, liquidity] =
        await ethers.getSigners();

      const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
      const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
        await rush.getAddress(),
      );
      const vesting = await (
        await ethers.getContractFactory("RushoodVesting")
      ).deploy(teamBeneficiary.address, BigInt(await time.latest()) + 60n);

      const destinations = {
        treasury: await treasury.getAddress(),
        // Liquidity is held only until the pool is seeded, then the position NFT is
        // locked; at genesis it lands on the deploying account.
        liquidity: liquidity.address,
        community: community.address,
        team: await vesting.getAddress(),
        staking: staking.address,
      };

      return { rush, treasury, vesting, destinations, deployer, community, staking };
    }

    it("lands every bucket at its destination", async () => {
      const { rush, destinations, deployer } = await deployStack();

      await distributeGenesis(rush as never, deployer.address, destinations);

      const expected = allocations();
      expect(await rush.balanceOf(destinations.treasury)).to.equal(expected.treasury);
      expect(await rush.balanceOf(destinations.liquidity)).to.equal(expected.liquidity);
      expect(await rush.balanceOf(destinations.community)).to.equal(expected.community);
      expect(await rush.balanceOf(destinations.team)).to.equal(expected.team);
      expect(await rush.balanceOf(destinations.staking)).to.equal(expected.staking);
    });

    it("leaves nothing on the distributor", async () => {
      const { rush, destinations, deployer } = await deployStack();
      await distributeGenesis(rush as never, deployer.address, destinations);
      expect(await rush.balanceOf(deployer.address)).to.equal(0n);
    });

    it("does not change the total supply", async () => {
      const { rush, destinations, deployer } = await deployStack();
      await distributeGenesis(rush as never, deployer.address, destinations);
      expect(await rush.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("funds the vesting wallet so the team schedule can actually pay out", async () => {
      const { rush, vesting, destinations, deployer } = await deployStack();
      await distributeGenesis(rush as never, deployer.address, destinations);
      expect(await rush.balanceOf(await vesting.getAddress())).to.equal(allocations().team);
    });

    it("refuses to distribute if the distributor is short of the full supply", async () => {
      const { rush, destinations, deployer, community } = await deployStack();
      await rush.transfer(community.address, 1n);

      await expect(
        distributeGenesis(rush as never, deployer.address, destinations),
      ).to.be.rejectedWith(/expected the full supply/);
    });

    it("refuses to distribute to an unset destination", async () => {
      const { rush, destinations, deployer } = await deployStack();
      const broken = { ...destinations, staking: ethers.ZeroAddress };

      await expect(
        distributeGenesis(rush as never, deployer.address, broken),
      ).to.be.rejectedWith(/destination for "staking" is unset/);
    });

    it("moves nothing when it refuses", async () => {
      const { rush, destinations, deployer } = await deployStack();
      const broken = { ...destinations, community: ethers.ZeroAddress };

      await expect(distributeGenesis(rush as never, deployer.address, broken)).to.be.rejected;
      expect(await rush.balanceOf(deployer.address)).to.equal(MAX_SUPPLY);
    });
  });
});
