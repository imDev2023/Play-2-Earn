import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { buildHashChain } from "../scripts/lib/hashchain";

const COINFLIP_TIER = 0; // 1-in-2
const BPS_DEN = 10_000n;
const DEFAULT_BURN_RATE_BPS = 250n; // 2.5%
const MAX_BURN_RATE_BPS = 1_000n; // 10% ceiling
const TREASURY_FUNDING = 1_000_000n * 10n ** 18n;
const PLAYER_FUNDING = 100_000n * 10n ** 18n;
const STAKE = 100n * 10n ** 18n;

/** On-chain outcome twin for the coinflip tier: win when keccak256(reveal, seed) is even. */
function isWin(reveal: string, clientSeed: bigint): boolean {
  const outcome = BigInt(
    ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [reveal, clientSeed])),
  );
  return outcome % 2n === 0n;
}

function seedForOutcome(reveal: string, wantWin: boolean): bigint {
  for (let i = 0n; i < 1000n; i++) {
    if (isWin(reveal, i) === wantWin) return i;
  }
  throw new Error("no seed found");
}

function burnOf(stake: bigint, bps = DEFAULT_BURN_RATE_BPS): bigint {
  return (stake * bps) / BPS_DEN;
}

describe("Deflation — per-play burn + treasury profit-burn (#21)", () => {
  async function deploy(chainLength = 32) {
    const [deployer, player, relayer, outsider] = await ethers.getSigners();
    const chain = buildHashChain("deflation-test", chainLength);

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const treasury = await (await ethers.getContractFactory("Treasury")).deploy(
      await rush.getAddress(),
    );
    const game = await (await ethers.getContractFactory("RushoodGame")).deploy(
      await rush.getAddress(),
      await treasury.getAddress(),
      chain[0],
      relayer.address,
    );
    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING);
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return { rush, treasury, game, deployer, player, relayer, outsider, chain };
  }

  async function balances(rush: any, treasury: any) {
    return {
      supply: (await rush.totalSupply()) as bigint,
      treasury: (await rush.balanceOf(await treasury.getAddress())) as bigint,
    };
  }

  describe("burn rate config", () => {
    it("defaults to a 2.5% (250 bps) burn rate with a 10% ceiling", async () => {
      const { game } = await deploy();
      expect(await game.burnRateBps()).to.equal(DEFAULT_BURN_RATE_BPS);
      expect(await game.MAX_BURN_RATE_BPS()).to.equal(MAX_BURN_RATE_BPS);
    });

    it("governance can update the burn rate", async () => {
      const { game, deployer } = await deploy();
      await expect(game.connect(deployer).setBurnRate(100n))
        .to.emit(game, "BurnRateUpdated")
        .withArgs(100n);
      expect(await game.burnRateBps()).to.equal(100n);
    });

    it("rejects a burn-rate update from a non-governance caller", async () => {
      const { game, outsider } = await deploy();
      await expect(game.connect(outsider).setBurnRate(100n)).to.be.revertedWithCustomError(
        game,
        "NotGovernance",
      );
    });

    it("rejects a burn rate above the ceiling", async () => {
      const { game, deployer } = await deploy();
      await expect(
        game.connect(deployer).setBurnRate(MAX_BURN_RATE_BPS + 1n),
      ).to.be.revertedWithCustomError(game, "BurnRateTooHigh");
    });
  });

  describe("per-play burn", () => {
    it("burns 2.5% of the stake on a losing settle; the remainder accrues to the treasury", async () => {
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      const before = await balances(rush, treasury);
      const seed = seedForOutcome(chain[1], false);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seed);

      const burn = burnOf(STAKE);
      await expect(game.connect(relayer).settleBet(chain[1]))
        .to.emit(game, "StakeBurned")
        .withArgs(1n, burn);

      const after = await balances(rush, treasury);
      expect(after.supply).to.equal(before.supply - burn);
      // Treasury keeps the stake minus the burned slice (97.5%).
      expect(after.treasury).to.equal(before.treasury + STAKE - burn);
    });

    it("burns 2.5% of the stake on a winning settle too", async () => {
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      const before = await balances(rush, treasury);
      const seed = seedForOutcome(chain[1], true);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seed);

      const burn = burnOf(STAKE);
      const payout = await game.payoutFor(COINFLIP_TIER, STAKE);
      await expect(game.connect(relayer).settleBet(chain[1]))
        .to.emit(game, "StakeBurned")
        .withArgs(1n, burn);

      const after = await balances(rush, treasury);
      expect(after.supply).to.equal(before.supply - burn);
      expect(after.treasury).to.equal(before.treasury + STAKE - payout - burn);
    });

    it("burns at the updated rate after setBurnRate", async () => {
      const { rush, treasury, game, deployer, player, relayer, chain } = await deploy();
      await game.connect(deployer).setBurnRate(100n); // 1%
      const before = await balances(rush, treasury);
      const seed = seedForOutcome(chain[1], false);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seed);
      await game.connect(relayer).settleBet(chain[1]);
      const after = await balances(rush, treasury);
      expect(after.supply).to.equal(before.supply - burnOf(STAKE, 100n));
    });

    it("a max-rate burn after a max moonshot win never bricks the payout", async () => {
      // Worst case for solvency: biggest allowed win on the 950x tier AND the 10% burn
      // ceiling. Because the burn runs after the payout, settle must still succeed.
      const { game, deployer, player, relayer, chain } = await deploy();
      await game.connect(deployer).setBurnRate(MAX_BURN_RATE_BPS);
      const tier = 5; // moonshot
      const maxBet = (await game.maxBet(tier)) as bigint;
      // Find a winning seed for the moonshot on this reveal.
      let seed = 0n;
      const reveal = chain[1];
      for (let i = 0n; i < 100_000n; i++) {
        const outcome = BigInt(
          ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [reveal, i])),
        );
        if (outcome % 1000n === 0n) {
          seed = i;
          break;
        }
      }
      await game.connect(player).placeBet(tier, maxBet, seed);
      await expect(game.connect(relayer).settleBet(reveal))
        .to.emit(game, "BetSettled")
        .withArgs(1n, player.address, true, await game.payoutFor(tier, maxBet));
    });

    it("does NOT burn on a refund (a refund is a cancelled play, not a settled one)", async () => {
      const { rush, treasury, game, player } = await deploy();
      const before = await balances(rush, treasury);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await game.connect(player).refund(1n);
      const after = await balances(rush, treasury);
      expect(after.supply).to.equal(before.supply); // supply untouched
      expect(after.treasury).to.equal(before.treasury); // stake fully returned
    });
  });

  describe("supply invariant", () => {
    it("totalSupply strictly decreases across a sequence of plays at the default rate", async () => {
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      let prev = (await rush.totalSupply()) as bigint;
      // Alternate wins and losses so both settlement paths are exercised.
      for (let round = 1; round <= 10; round++) {
        const wantWin = round % 2 === 0;
        const seed = seedForOutcome(chain[round], wantWin);
        await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seed);
        await game.connect(relayer).settleBet(chain[round]);
        const now = (await rush.totalSupply()) as bigint;
        expect(now).to.be.lt(prev); // strictly decreasing at the default rate
        prev = now;
      }
    });

    it("totalSupply never increases — even across a zero-rate play and a refund", async () => {
      // The hard invariant is monotone NON-increasing (RUSH has no mint path). Interleave
      // the flat-step cases — a 0% burn play and a refund — and confirm no step ever rises,
      // while the whole sequence still nets a decrease overall.
      const { rush, treasury, game, deployer, player, relayer, chain } = await deploy();
      const start = (await rush.totalSupply()) as bigint;
      let prev = start;
      const check = async () => {
        const now = (await rush.totalSupply()) as bigint;
        expect(now).to.be.lte(prev); // never increases
        prev = now;
      };

      // 1) Default-rate play → strict drop.
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seedForOutcome(chain[1], false));
      await game.connect(relayer).settleBet(chain[1]);
      await check();

      // 2) Zero-rate play → flat step (burn skipped), must not increase.
      await game.connect(deployer).setBurnRate(0n);
      const beforeFlat = (await rush.totalSupply()) as bigint;
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seedForOutcome(chain[2], true));
      await game.connect(relayer).settleBet(chain[2]);
      expect(await rush.totalSupply()).to.equal(beforeFlat); // genuinely flat
      await check();

      // 3) Refund → flat step (a cancelled play burns nothing).
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 9n);
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await game.connect(player).refund(3n);
      await check();

      // 4) Restore the rate → strict drop again.
      await game.connect(deployer).setBurnRate(DEFAULT_BURN_RATE_BPS);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, seedForOutcome(chain[3], false));
      await game.connect(relayer).settleBet(chain[3]);
      await check();

      expect((await rush.totalSupply()) as bigint).to.be.lt(start); // net deflation overall
    });
  });

  describe("treasury profit-burn", () => {
    it("governance burns treasury profit, reducing totalSupply", async () => {
      const { rush, treasury, game, deployer } = await deploy();
      const before = await balances(rush, treasury);
      const amount = 5_000n * 10n ** 18n;
      await expect(game.connect(deployer).burnTreasuryProfit(amount))
        .to.emit(game, "TreasuryProfitBurned")
        .withArgs(amount);
      const after = await balances(rush, treasury);
      expect(after.supply).to.equal(before.supply - amount);
      expect(after.treasury).to.equal(before.treasury - amount);
    });

    it("rejects a profit-burn that would drop the treasury below the floor", async () => {
      const { game, deployer } = await deploy();
      const floor = (await game.treasuryFloor()) as bigint;
      const overBurn = TREASURY_FUNDING - floor + 1n; // one wei past the floor
      await expect(
        game.connect(deployer).burnTreasuryProfit(overBurn),
      ).to.be.revertedWithCustomError(game, "BurnBelowFloor");
    });

    it("rejects a profit-burn from a non-governance caller", async () => {
      const { game, outsider } = await deploy();
      await expect(
        game.connect(outsider).burnTreasuryProfit(1n),
      ).to.be.revertedWithCustomError(game, "NotGovernance");
    });

    it("rejects a profit-burn while a bet is active", async () => {
      const { game, deployer, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await expect(
        game.connect(deployer).burnTreasuryProfit(1n),
      ).to.be.revertedWithCustomError(game, "BurnWhileBetActive");
    });
  });
});
