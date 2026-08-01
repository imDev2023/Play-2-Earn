import { expect } from "chai";
import { ethers } from "hardhat";
import { seedForOutcome as seedFor } from "@rushood/verifier";
import type { Hex } from "@rushood/verifier";
import { buildHashChain } from "../scripts/lib/hashchain";

// Mirrors of the on-chain economic constants (see RushoodGame.sol).
const MIN_BET = 1n * 10n ** 18n;
const EDGE_NUM = 95n; // payout factor 0.95 => 5% house edge
const EDGE_DEN = 100n;
const TREASURY_CAP_DEN = 100n; // maxPayout = 1% of treasury balance
// = MIN_BET * EDGE_NUM * 1000 (max odds): the pool at which maxBet(moonshot) == MIN_BET.
const TREASURY_FLOOR = 95_000n * 10n ** 18n;

/** Odds N for each tier index: a 1-in-N shot. */
const TIER_ODDS = [2n, 4n, 10n, 50n, 100n, 1000n];

const PLAYER_FUNDING = 5_000_000n * 10n ** 18n;

/** Off-chain twin of the on-chain payout: stake * 0.95 * N. */
function payoutFor(tier: number, stake: bigint): bigint {
  return (stake * EDGE_NUM * TIER_ODDS[tier]) / EDGE_DEN;
}

/** withArgs predicate: any losing roll (a win is exactly 0, a loss is anything else). */
const anyNonZeroRoll = (roll: bigint) => roll !== 0n;

/**
 * Smallest clientSeed producing the desired win/loss for a reveal on a tier.
 * Delegates to the public verifier so the tests and the game share one formula (#24).
 */
function seedForOutcome(reveal: string, tier: number, wantWin: boolean, betId = 1n): bigint {
  return seedFor({ betId, tier, serverReveal: reveal as Hex }, wantWin, 100_000n);
}

describe("Odds tiers + payout math + solvency caps (#20)", () => {
  async function deploy(treasuryFunding = 1_000_000n * 10n ** 18n) {
    const [deployer, player, relayer, outsider] = await ethers.getSigners();
    const chain = buildHashChain("odds-tiers-test", 64);

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
    if (treasuryFunding > 0n) {
      await rush.transfer(await treasury.getAddress(), treasuryFunding);
    }
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return { rush, treasury, game, deployer, player, relayer, outsider, chain };
  }

  describe("tier table", () => {
    it("exposes the six odds tiers 1-in-2/4/10/50/100/1000", async () => {
      const { game } = await deploy();
      expect(await game.TIER_COUNT()).to.equal(6n);
      for (let t = 0; t < TIER_ODDS.length; t++) {
        expect(await game.odds(t)).to.equal(TIER_ODDS[t]);
      }
    });

    it("reverts odds() for an out-of-range tier", async () => {
      const { game } = await deploy();
      await expect(game.odds(6)).to.be.revertedWithCustomError(game, "InvalidTier");
    });
  });

  describe("payout math", () => {
    it("pays 0.95 x N on each tier (moonshot 950x)", async () => {
      const { game } = await deploy();
      const stake = 100n * 10n ** 18n;
      const expected = [190n, 380n, 950n, 4750n, 9500n, 95000n].map((x) => x * 10n ** 18n);
      for (let t = 0; t < TIER_ODDS.length; t++) {
        expect(await game.payoutFor(t, stake)).to.equal(expected[t]);
      }
    });

    it("property: expected return is exactly 0.95 on every tier (divisible stakes)", async () => {
      const { game } = await deploy();
      // Expected winnings per bet = (1/N) * payout = 0.95 * stake, for ANY tier.
      // Stakes that are multiples of EDGE_DEN keep the integer arithmetic exact.
      const stakes = Array.from({ length: 40 }, (_, i) =>
        (BigInt(i) + 1n) * 137n * EDGE_DEN * 10n ** 12n,
      );
      for (let t = 0; t < TIER_ODDS.length; t++) {
        for (const stake of stakes) {
          const payout = await game.payoutFor(t, stake);
          // (1/N) * payout must equal 0.95 * stake exactly.
          expect(payout / TIER_ODDS[t]).to.equal((stake * EDGE_NUM) / EDGE_DEN);
        }
      }
    });

    it("property: for ARBITRARY stakes the edge is never below 5% (house never overpays)", async () => {
      const { game } = await deploy();
      // For stakes not divisible by EDGE_DEN the payout floors, nudging the edge
      // slightly *above* 5% - so expected return is always <= 0.95 * stake, never more.
      // Fuzz jagged, indivisible stakes across a wide magnitude range.
      const stakes = Array.from({ length: 50 }, (_, i) => {
        const base = (BigInt(i) + 1n) ** 3n * 7919n + 3n; // never a clean multiple of 100
        return base * 10n ** 10n + BigInt(i) * 13n + 1n;
      });
      for (let t = 0; t < TIER_ODDS.length; t++) {
        for (const stake of stakes) {
          const payout = await game.payoutFor(t, stake);
          const expectedReturn = payout / TIER_ODDS[t]; // (1/N) * payout
          expect(expectedReturn).to.be.lte((stake * EDGE_NUM) / EDGE_DEN);
        }
      }
    });
  });

  describe("bet sizing (min / max)", () => {
    it("rejects a stake below MIN_BET", async () => {
      const { game, player } = await deploy();
      expect(await game.minBet()).to.equal(MIN_BET);
      await expect(
        game.connect(player).placeBet(0, MIN_BET - 1n, 1n),
      ).to.be.revertedWithCustomError(game, "BetBelowMin");
    });

    it("maxBet(tier) = maxPayout / multiplier and caps the stake", async () => {
      const { game, treasury, rush, player } = await deploy();
      const balance = await rush.balanceOf(await treasury.getAddress());
      for (let t = 0; t < TIER_ODDS.length; t++) {
        const maxBet = await game.maxBet(t);
        expect(maxBet).to.equal(balance / (EDGE_NUM * TIER_ODDS[t]));
        // A bet one wei over the cap is rejected...
        await expect(
          game.connect(player).placeBet(t, maxBet + 1n, 1n),
        ).to.be.revertedWithCustomError(game, "ExceedsMaxBet");
        // ...and the payout on a max bet stays within the 1% solvency cap.
        expect(await game.payoutFor(t, maxBet)).to.be.lte(await game.maxPayout());
      }
    });

    it("accepts a stake exactly at maxBet(tier)", async () => {
      const { game, player } = await deploy();
      const maxBet = await game.maxBet(0);
      await expect(game.connect(player).placeBet(0, maxBet, 1n)).to.emit(game, "BetPlaced");
    });

    it("maxPayout is 1% of the treasury balance", async () => {
      const { game, treasury, rush } = await deploy();
      const balance = await rush.balanceOf(await treasury.getAddress());
      expect(await game.maxPayout()).to.equal(balance / TREASURY_CAP_DEN);
    });
  });

  describe("bet lifecycle across tiers", () => {
    it("records the chosen tier and stake on placeBet", async () => {
      const { game, player, chain } = await deploy();
      const stake = 100n * 10n ** 18n; // within maxBet(3) at 1M funding
      await expect(game.connect(player).placeBet(3, stake, 42n))
        .to.emit(game, "BetPlaced")
        .withArgs(1n, player.address, 3, stake, 42n, chain[0]);
      const bet = await game.bets(1n);
      expect(bet.tier).to.equal(3);
      expect(bet.stake).to.equal(stake);
    });

    it("pays 0.95 x N x stake from the treasury on a winning settle", async () => {
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      const tier = 2; // 1-in-10, 9.5x
      const stake = 50n * 10n ** 18n;
      const seed = seedForOutcome(chain[1], tier, true);
      await game.connect(player).placeBet(tier, stake, seed);

      const payout = payoutFor(tier, stake);
      const treasuryBefore = await rush.balanceOf(await treasury.getAddress());
      await expect(game.connect(relayer).settleBet(chain[1]))
        .to.emit(game, "BetSettled")
        // A win is a roll of 0 on every tier; the reveal rides along so the draw is
        // publicly recomputable (#24).
        .withArgs(1n, player.address, true, payout, chain[1], 0n);
      // Settle pays the win and burns 2.5% of the stake (#21 deflation).
      const burn = (stake * 250n) / 10_000n;
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(
        treasuryBefore - payout - burn,
      );
    });

    it("keeps the stake on a losing settle", async () => {
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      const tier = 5; // moonshot: losses are overwhelmingly likely
      const stake = MIN_BET;
      const seed = seedForOutcome(chain[1], tier, false);
      await game.connect(player).placeBet(tier, stake, seed);
      const treasuryBefore = await rush.balanceOf(await treasury.getAddress());
      await expect(game.connect(relayer).settleBet(chain[1]))
        .to.emit(game, "BetSettled")
        .withArgs(1n, player.address, false, 0n, chain[1], anyNonZeroRoll);
      // The stake stays, less the 2.5% burn (#21 deflation).
      const burn = (stake * 250n) / 10_000n;
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(treasuryBefore - burn);
    });
  });

  describe("solvency: floor + depletion", () => {
    it("pauses (rejects all bets) when the treasury is below the floor", async () => {
      const { game, player } = await deploy(TREASURY_FLOOR - 1n);
      expect(await game.treasuryFloor()).to.equal(TREASURY_FLOOR);
      await expect(
        game.connect(player).placeBet(0, MIN_BET, 1n),
      ).to.be.revertedWithCustomError(game, "TreasuryBelowFloor");
    });

    it("keeps every tier playable at MIN_BET right down to the floor", async () => {
      // The floor is chosen so the riskiest tier's min bet exactly saturates the cap.
      const { game, player, relayer, chain } = await deploy(TREASURY_FLOOR);
      for (let t = 0; t < TIER_ODDS.length; t++) {
        expect(await game.maxBet(t)).to.be.gte(MIN_BET);
      }
      expect(await game.maxBet(5)).to.equal(MIN_BET); // moonshot: exactly at the cap
      // And a moonshot MIN_BET bet actually places + settles at the floor.
      const seed = seedForOutcome(chain[1], 5, false);
      await expect(game.connect(player).placeBet(5, MIN_BET, seed)).to.emit(game, "BetPlaced");
      await expect(game.connect(relayer).settleBet(chain[1])).to.emit(game, "BetSettled");
    });

    it("a placed bet is always payable - no underfunded-treasury brick", async () => {
      // Place the largest allowed moonshot bet; the treasury must still cover the
      // 950x payout at settle time (the cap is what guarantees this).
      const { rush, treasury, game, player, relayer, chain } = await deploy();
      const tier = 5;
      const maxBet = await game.maxBet(tier);
      const seed = seedForOutcome(chain[1], tier, true);
      await game.connect(player).placeBet(tier, maxBet, seed);
      // Settlement must NOT revert for want of funds.
      await expect(game.connect(relayer).settleBet(chain[1]))
        .to.emit(game, "BetSettled")
        .withArgs(1n, player.address, true, payoutFor(tier, maxBet), chain[1], 0n);
    });

    it("shrinks the safe cap as the pool depletes (each win keeps within maxPayout)", async () => {
      // The 1% cap deliberately makes the pool hard to drain: each max win removes
      // well under 1% net. So rather than grind to the floor, assert the depletion
      // dynamics - the cap tracks the shrinking balance and every win stays capped.
      const { game, player, relayer, chain } = await deploy(TREASURY_FLOOR + 5_000n * 10n ** 18n);
      let prevCap = await game.maxBet(0);
      for (let round = 1; round <= 4; round++) {
        const stake = await game.maxBet(0);
        expect(await game.payoutFor(0, stake)).to.be.lte(await game.maxPayout());
        const seed = seedForOutcome(chain[round], 0, true, BigInt(round));
        await game.connect(player).placeBet(0, stake, seed);
        await game.connect(relayer).settleBet(chain[round]);
        const cap = await game.maxBet(0);
        expect(cap).to.be.lt(prevCap); // pool depleting => cap shrinks monotonically
        prevCap = cap;
      }
    });

    it("pauses once the pool has been drained below the floor", async () => {
      // Fund a hair above the floor, then let a single max win tip it under.
      const { game, player, relayer, chain, rush, treasury } = await deploy(
        TREASURY_FLOOR + 40n * 10n ** 18n,
      );
      const stake = await game.maxBet(0);
      const seed = seedForOutcome(chain[1], 0, true);
      await game.connect(player).placeBet(0, stake, seed);
      await game.connect(relayer).settleBet(chain[1]);
      expect(await rush.balanceOf(await treasury.getAddress())).to.be.lt(TREASURY_FLOOR);
      await expect(
        game.connect(player).placeBet(0, MIN_BET, 1n),
      ).to.be.revertedWithCustomError(game, "TreasuryBelowFloor");
    });
  });
});
