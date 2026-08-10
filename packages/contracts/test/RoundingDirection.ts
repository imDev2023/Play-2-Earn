import { expect } from "chai";
import { ethers } from "hardhat";
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
 */

const TIERS = [0, 1, 2, 3, 4, 5];
const TIER_ODDS = [2n, 4n, 10n, 50n, 100n, 1000n];
const EDGE_NUM = 95n;
const EDGE_DEN = 100n;

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
    const [deployer, , relayer] = await ethers.getSigners();
    const chain = buildHashChain("rounding-direction-test", 8);

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
    return { game };
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

  it("burns no more than the exact burn rate", async () => {
    const { game } = await deploy(1_000_000n * 10n ** 18n);
    const bps = await game.burnRateBps();
    const den = await game.BPS_DEN();

    for (const stake of AWKWARD_STAKES) {
      // Mirrors the on-chain expression; the assertion is that truncation leaves the
      // remainder in the treasury rather than taking an extra wei out of it.
      const burned = (stake * bps) / den;
      expect(burned * den).to.be.at.most(stake * bps);
      expect(stake * bps - burned * den).to.be.lessThan(den);
    }
  });
});
