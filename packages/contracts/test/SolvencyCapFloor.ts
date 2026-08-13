import { expect } from "chai";
import { ethers } from "hardhat";
import { buildHashChain } from "../scripts/lib/hashchain";

/**
 * The solvency cap's lower bound (#57).
 *
 * `maxPayout()` is `treasuryBalance() / solvencyCapDen`, so a *small* denominator is the
 * dangerous one: `setSolvencyCap(1)` sets maxPayout to the whole treasury and a single
 * win can take the bankroll. Before #57 the setter bounded only the top of the range,
 * which is the safe direction, and that is exactly why the gap read as covered.
 *
 * These assertions are anchored to the spec's percentages written out as literals here,
 * and every value under test is read back off the chain. Deriving the expectation from
 * `solvencyCapDen` or from `maxPayout()` itself would recompute the implementation and
 * pass for every input, which is the failure this repo keeps re-learning.
 *
 * Note what this floor does NOT do: it does not enforce section 5's 1%. The seeded
 * default is 1% and the floor bounds how far governance may loosen it, to 5%. The spec
 * says so too, and the two must keep agreeing.
 */
describe("Solvency cap floor (#57)", () => {
  /** Spec section 5: the seeded default is 1% of the treasury. */
  const SPEC_DEFAULT_PERCENT = 1n;
  /** Spec section 5: governance may loosen the cap no further than 5%. */
  const SPEC_MAX_LOOSENED_PERCENT = 5n;

  const TREASURY = 1_000_000n * 10n ** 18n;

  async function deploy() {
    const [deployer, player, relayer] = await ethers.getSigners();
    const chain = buildHashChain("solvency-cap-floor-test", 8);

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const treasury = await (
      await ethers.getContractFactory("Treasury")
    ).deploy(await rush.getAddress());
    const game = await (
      await ethers.getContractFactory("RushoodGame")
    ).deploy(await rush.getAddress(), await treasury.getAddress(), chain[0], relayer.address);

    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), TREASURY);
    await rush.transfer(player.address, 100_000n * 10n ** 18n);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);
    return { rush, treasury, game, deployer, player, relayer, chain };
  }

  it("seeds the cap at the spec's 1% of the treasury", async () => {
    const { game } = await deploy();

    // Read both off the chain; the only number from the test is the spec's percentage.
    const balance = await game.treasuryBalance();
    const maxPayout = await game.maxPayout();

    expect(maxPayout * 100n).to.equal(balance * SPEC_DEFAULT_PERCENT);
  });

  it("rejects the denominator that would make a single win take the whole treasury", async () => {
    // The case that opened #57. Before the floor this succeeded, and maxPayout became
    // the entire treasury balance.
    const { game } = await deploy();
    await game.setEconomicsGovernable(true);

    await expect(game.setSolvencyCap(1)).to.be.revertedWithCustomError(game, "InvalidEconomics");
  });

  it("accepts the floor itself and rejects one below it", async () => {
    // The bound must reject only what is genuinely too loose, so both sides are pinned.
    const { game } = await deploy();
    await game.setEconomicsGovernable(true);

    const floor = await game.MIN_SOLVENCY_CAP_DEN();

    await expect(game.setSolvencyCap(floor - 1n)).to.be.revertedWithCustomError(
      game,
      "InvalidEconomics",
    );
    await expect(game.setSolvencyCap(floor)).to.not.be.reverted;
  });

  it("caps the loosest reachable payout at the spec's 5% of the treasury", async () => {
    // The property the floor exists to guarantee, stated as the spec states it and read
    // back off the chain rather than recomputed from `solvencyCapDen`.
    const { game } = await deploy();
    await game.setEconomicsGovernable(true);

    await game.setSolvencyCap(await game.MIN_SOLVENCY_CAP_DEN());

    const balance = await game.treasuryBalance();
    const maxPayout = await game.maxPayout();

    expect(maxPayout * 100n).to.be.lessThanOrEqual(balance * SPEC_MAX_LOOSENED_PERCENT);
  });

  it("still rejects a denominator too large for the packed storage", async () => {
    // The pre-existing upper bound must survive the new lower one; a floor written as a
    // replacement rather than an addition would silently drop it.
    const { game } = await deploy();
    await game.setEconomicsGovernable(true);

    const ceiling = await game.MAX_ECONOMIC_RATIO();

    await expect(game.setSolvencyCap(ceiling + 1n)).to.be.revertedWithCustomError(
      game,
      "InvalidEconomics",
    );
    await expect(game.setSolvencyCap(ceiling)).to.not.be.reverted;
  });

  it("keeps the floor below the seeded default, so the default stays reachable", async () => {
    // A floor above `DEFAULT_SOLVENCY_CAP_DEN` would make the shipped configuration
    // unsettable, which no test asserting only the boundary would notice.
    const { game } = await deploy();

    expect(await game.MIN_SOLVENCY_CAP_DEN()).to.be.lessThanOrEqual(
      await game.DEFAULT_SOLVENCY_CAP_DEN(),
    );
  });
});
