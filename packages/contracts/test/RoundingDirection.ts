import { expect } from "chai";
import { ethers } from "hardhat";
import { seedForOutcome as seedFor } from "@rushood/verifier";
import type { Hex } from "@rushood/verifier";
import { buildHashChain } from "../scripts/lib/hashchain";

/**
 * Rounding direction, as an ordinary Hardhat test.
 *
 * The evm-security package ships `RoundingDirectionProperties`, but it is Foundry-only:
 * it needs `vm.snapshotState` / `vm.revertToState` to probe a round trip without
 * perturbing the campaign, and there is no portable equivalent. The package's own
 * Hardhat README says so and recommends exactly this substitute - "a deterministic
 * probe, not really a fuzzing target: pick awkward amounts and assert you got back no
 * more than you put in". `arith-rounding-tested` is waived in .evm-standards.json
 * pointing here.
 *
 * Awkward on purpose. Every amount below is chosen so that at least one of the three
 * divisions leaves a remainder; round numbers would pass whichever way the truncation
 * went, which is the failure mode this file exists to avoid.
 *
 * Every assertion here compares a value READ BACK FROM THE CHAIN against arithmetic
 * derived from the spec (docs/spec/RUSHOOD-game-spec.md §4 and §5), never against a
 * TypeScript restatement of the contract's own expression. A test that recomputes the
 * implementation and then checks its own recomputation agrees with itself is a
 * tautology of integer division: it passes for every input and would keep passing if
 * the contract rounded the other way. The burn case below was written that way once
 * and caught in review.
 */

const TIERS = [0, 1, 2, 3, 4, 5];
const TIER_ODDS = [2n, 4n, 10n, 50n, 100n, 1000n];
const EDGE_NUM = 95n;
const EDGE_DEN = 100n;
const COINFLIP_TIER = 0;
const TREASURY_FUNDING = 1_000_000n * 10n ** 18n;
const PLAYER_FUNDING = 100_000n * 10n ** 18n;

/** Spec §5: the per-play burn is a fixed fraction of the stake, defaulting to ~2.5%. */
const SPEC_BURN_RATE_BPS = 250n;

/** Stakes and balances picked to leave a remainder under /100 and /(100*95*N). */
const AWKWARD_STAKES = [
  1n * 10n ** 18n + 1n,
  1n * 10n ** 18n + 7n,
  3n * 10n ** 18n + 99n,
  12_345_678_901_234_567_891n,
  999_999_999_999_999_999n + 1n * 10n ** 18n,
];

const AWKWARD_BALANCES = [
  1_000_000n * 10n ** 18n + 1n,
  1_234_567n * 10n ** 18n + 89n,
  95_001n * 10n ** 18n + 7n,
];

describe("Rounding direction always favours the protocol", () => {
  async function deploy(treasuryFunding: bigint) {
    const [deployer, player, relayer] = await ethers.getSigners();
    const chain = buildHashChain("rounding-direction-test", 16);

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const treasury = await (
      await ethers.getContractFactory("Treasury")
    ).deploy(await rush.getAddress());
    const game = await (
      await ethers.getContractFactory("RushoodGame")
    ).deploy(
      await rush.getAddress(),
      await treasury.getAddress(),
      chain[0],
      relayer.address,
    );
    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), treasuryFunding);
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);
    return { rush, treasury, game, player, relayer, chain };
  }

  /**
   * Smallest clientSeed producing the desired outcome, via the public verifier - the
   * tests and the game share one formula (#24). `betId` is mixed into the draw, so the
   * seed that wins bet 1 does not win bet 2.
   */
  function seedForOutcome(reveal: string, wantWin: boolean, betId: bigint): bigint {
    return seedFor({ betId, tier: COINFLIP_TIER, serverReveal: reveal as Hex }, wantWin, 100_000n);
  }

  it("never pays a winner more than the exact 0.95 x N x stake", async () => {
    const { game } = await deploy(1_000_000n * 10n ** 18n);

    for (const tier of TIERS) {
      for (const stake of AWKWARD_STAKES) {
        const paid = await game.payoutFor(tier, stake);
        const exactNumerator = stake * EDGE_NUM * TIER_ODDS[tier];

        // Rounded down, never up: the house keeps the remainder.
        expect(paid * EDGE_DEN).to.be.at.most(exactNumerator);
        // And it is a truncation rather than an arbitrary shortfall.
        expect(exactNumerator - paid * EDGE_DEN).to.be.lessThan(EDGE_DEN);
      }
    }
  });

  it("never advertises a maximum bet whose win exceeds the solvency cap", async () => {
    // The one rounding relationship that can actually brick the game. `maxBet` divides
    // and `payoutFor` multiplies back up, so a maxBet rounded the wrong way would offer a
    // stake whose win the treasury is not required to be able to cover.
    for (const funding of AWKWARD_BALANCES) {
      const { game } = await deploy(funding);
      const cap = await game.maxPayout();

      for (const tier of TIERS) {
        const max = await game.maxBet(tier);
        expect(await game.payoutFor(tier, max)).to.be.at.most(cap);
      }
    }
  });

  it("burns the stake fraction the spec names, at the default rate", async () => {
    // Pins §5's "~2.5% of stake" to a number rather than reading the rate back out of
    // the contract and comparing it to itself.
    const { game } = await deploy(TREASURY_FUNDING);
    expect(await game.burnRateBps()).to.equal(SPEC_BURN_RATE_BPS);
    expect(await game.BPS_DEN()).to.equal(10_000n);
  });

  it("burns no more than the exact burn rate, measured on chain", async () => {
    // Settles a real bet per awkward stake and reads the burn off the chain: the
    // `StakeBurned` amount and the totalSupply delta must agree, and both must be the
    // truncation of stake * bps / BPS_DEN rather than a rounding-up of it. Alternating
    // win and loss exercises both settlement paths, since the burn runs on each.
    const { rush, game, player, relayer, chain } = await deploy(TREASURY_FUNDING);
    const bps = await game.burnRateBps();
    const den = await game.BPS_DEN();

    for (const [round, stake] of AWKWARD_STAKES.entries()) {
      const betId = BigInt(round + 1);
      const reveal = chain[round + 1];
      const wantWin = round % 2 === 0;

      const supplyBefore = (await rush.totalSupply()) as bigint;
      await game.connect(player).placeBet(COINFLIP_TIER, stake, seedForOutcome(reveal, wantWin, betId));
      const receipt = await (await game.connect(relayer).settleBet(reveal)).wait();
      const supplyAfter = (await rush.totalSupply()) as bigint;

      const burnEvent = receipt!.logs
        .map((log) => {
          try {
            return game.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "StakeBurned");

      expect(burnEvent, `bet ${betId} emitted no StakeBurned`).to.not.be.undefined;
      const burned = burnEvent!.args.amount as bigint;

      // The burn actually happened, and for exactly the amount announced.
      expect(supplyBefore - supplyAfter).to.equal(burned);
      // Rounded down, never up: the remainder stays in the treasury.
      expect(burned * den).to.be.at.most(stake * bps);
      // And it is a truncation rather than an arbitrary shortfall.
      expect(stake * bps - burned * den).to.be.lessThan(den);
    }
  });
});
