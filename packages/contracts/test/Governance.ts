import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { buildHashChain } from "../scripts/lib/hashchain";

const COINFLIP_TIER = 0; // 1-in-2
const TREASURY_FUNDING = 1_000_000n * 10n ** 18n;
const PLAYER_FUNDING = 100_000n * 10n ** 18n;
const STAKE = 100n * 10n ** 18n;
const MIN_DELAY = 2n * 24n * 60n * 60n; // 2 days

const ZERO = ethers.ZeroHash;

describe("Governance - Safe multisig + Timelock + pause (#22)", () => {
  // signers: deployer, player, relayer, safe (the multisig), outsider
  async function deploy() {
    const [deployer, player, relayer, safe, outsider] = await ethers.getSigners();
    const chain = buildHashChain("governance-test", 32);

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
    // TimelockController controlled by the Safe multisig: the Safe is the sole
    // proposer AND executor; no separate admin (self-administered).
    const timelock = await (await ethers.getContractFactory("RushoodTimelock")).deploy(
      MIN_DELAY,
      [safe.address],
      [safe.address],
      ethers.ZeroAddress,
    );

    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING);
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return { rush, treasury, game, timelock, deployer, player, relayer, safe, outsider, chain };
  }

  /** Hand both governance roles to production holders: params → Timelock, pause → Safe. */
  async function handOff(game: any, deployer: any, timelock: any, safe: any) {
    await game.connect(deployer).setGuardian(safe.address);
    await game.connect(deployer).setGovernance(await timelock.getAddress());
  }

  /** Schedule a call on the timelock and execute it once the delay has elapsed. */
  async function timelockExec(timelock: any, safe: any, target: string, data: string) {
    await timelock.connect(safe).schedule(target, 0, data, ZERO, ZERO, MIN_DELAY);
    await time.increase(Number(MIN_DELAY) + 1);
    await timelock.connect(safe).execute(target, 0, data, ZERO, ZERO);
  }

  describe("role setup + migration", () => {
    it("governance and guardian default to the deployer", async () => {
      const { game, deployer } = await deploy();
      expect(await game.governance()).to.equal(deployer.address);
      expect(await game.guardian()).to.equal(deployer.address);
    });

    it("the deployer can hand governance to the timelock and pause to the Safe", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await expect(game.connect(deployer).setGuardian(safe.address))
        .to.emit(game, "GuardianTransferred")
        .withArgs(deployer.address, safe.address);
      await expect(game.connect(deployer).setGovernance(await timelock.getAddress()))
        .to.emit(game, "GovernanceTransferred")
        .withArgs(deployer.address, await timelock.getAddress());
      expect(await game.governance()).to.equal(await timelock.getAddress());
      expect(await game.guardian()).to.equal(safe.address);
    });

    it("rejects role transfers from non-governance callers", async () => {
      const { game, outsider } = await deploy();
      await expect(
        game.connect(outsider).setGovernance(outsider.address),
      ).to.be.revertedWithCustomError(game, "NotGovernance");
      await expect(
        game.connect(outsider).setGuardian(outsider.address),
      ).to.be.revertedWithCustomError(game, "NotGovernance");
    });

    it("rejects handing a role to the zero address", async () => {
      const { game, deployer } = await deploy();
      await expect(
        game.connect(deployer).setGovernance(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(game, "GovernanceIsZeroAddress");
      await expect(
        game.connect(deployer).setGuardian(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(game, "GuardianIsZeroAddress");
    });

    it("once governance is the timelock, the old deployer key can no longer govern", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      // The deployer is no longer governance: a direct burn-rate change reverts.
      await expect(game.connect(deployer).setBurnRate(100n)).to.be.revertedWithCustomError(
        game,
        "NotGovernance",
      );
    });
  });

  describe("sensitive setters behind the timelock", () => {
    it("a direct (non-timelock) burn-rate change reverts once governance is the timelock", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await expect(game.connect(safe).setBurnRate(100n)).to.be.revertedWithCustomError(
        game,
        "NotGovernance",
      );
    });

    it("a timelock-queued burn-rate change succeeds after the delay", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      const data = game.interface.encodeFunctionData("setBurnRate", [100n]);
      await timelockExec(timelock, safe, await game.getAddress(), data);
      expect(await game.burnRateBps()).to.equal(100n);
    });

    it("a queued change cannot be executed before the delay elapses", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      const target = await game.getAddress();
      const data = game.interface.encodeFunctionData("setBurnRate", [100n]);
      await timelock.connect(safe).schedule(target, 0, data, ZERO, ZERO, MIN_DELAY);
      // Executing immediately (delay not elapsed) is rejected by the timelock.
      await expect(
        timelock.connect(safe).execute(target, 0, data, ZERO, ZERO),
      ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
      expect(await game.burnRateBps()).to.equal(await game.DEFAULT_BURN_RATE_BPS());
    });

    it("the timelock can also trigger a treasury profit-burn", async () => {
      const { rush, game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      const amount = 5_000n * 10n ** 18n;
      const before = (await rush.totalSupply()) as bigint;
      const data = game.interface.encodeFunctionData("burnTreasuryProfit", [amount]);
      await timelockExec(timelock, safe, await game.getAddress(), data);
      expect((await rush.totalSupply()) as bigint).to.equal(before - amount);
    });
  });

  describe("emergency pause", () => {
    it("only the guardian can pause", async () => {
      const { game, deployer, timelock, safe, outsider } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await expect(game.connect(outsider).pause()).to.be.revertedWithCustomError(
        game,
        "NotGuardian",
      );
      await expect(game.connect(safe).pause()).to.emit(game, "Paused");
      expect(await game.paused()).to.equal(true);
    });

    it("pausing halts new bets", async () => {
      const { game, deployer, timelock, safe, player } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await game.connect(safe).pause();
      await expect(
        game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n),
      ).to.be.revertedWithCustomError(game, "EnforcedPause");
    });

    it("an already-active bet can still be settled while paused", async () => {
      const { game, deployer, timelock, safe, player, relayer, chain } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await game.connect(safe).pause();
      // Settlement is not gated by pause: an in-flight bet must still be able to resolve.
      await expect(game.connect(relayer).settleBet(chain[1])).to.emit(game, "BetSettled");
    });

    it("refund still works while paused", async () => {
      const { game, deployer, timelock, safe, player } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await game.connect(safe).pause();
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await expect(game.connect(player).refund(1n)).to.emit(game, "BetRefunded");
    });

    it("the guardian can unpause and bets resume", async () => {
      const { game, deployer, timelock, safe, player, relayer, chain } = await deploy();
      await handOff(game, deployer, timelock, safe);
      await game.connect(safe).pause();
      await expect(game.connect(safe).unpause()).to.emit(game, "Unpaused");
      // A full round works again after unpausing.
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await expect(game.connect(relayer).settleBet(chain[1])).to.emit(game, "BetSettled");
    });
  });

  describe("economic invariants - immutable by default, governable when enabled", () => {
    it("effective economics default to the #20 constants", async () => {
      const { game } = await deploy();
      expect(await game.economicsGovernable()).to.equal(false);
      expect(await game.minBet()).to.equal(await game.DEFAULT_MIN_BET());
      expect(await game.treasuryFloor()).to.equal(await game.DEFAULT_TREASURY_FLOOR());
      expect(await game.edgeNum()).to.equal(await game.DEFAULT_EDGE_NUM());
      expect(await game.edgeDen()).to.equal(await game.DEFAULT_EDGE_DEN());
      expect(await game.solvencyCapDen()).to.equal(await game.DEFAULT_SOLVENCY_CAP_DEN());
    });

    it("economic setters are locked even for governance while the flag is off", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      await handOff(game, deployer, timelock, safe);
      // Route through the timelock (the only path to governance) and confirm it still
      // reverts: the economics are locked regardless of who asks.
      const data = game.interface.encodeFunctionData("setMinBet", [2n * 10n ** 18n]);
      await timelock.connect(safe).schedule(await game.getAddress(), 0, data, ZERO, ZERO, MIN_DELAY);
      await time.increase(Number(MIN_DELAY) + 1);
      // The timelock bubbles the target's revert reason: the economy is still locked.
      await expect(
        timelock.connect(safe).execute(await game.getAddress(), 0, data, ZERO, ZERO),
      ).to.be.revertedWithCustomError(game, "EconomicsLocked");
    });

    it("enabling governance unlocks the economic setters (governance-gated)", async () => {
      const { game, deployer } = await deploy();
      // Still deployer-governed here; enable, then tune a knob.
      await expect(game.connect(deployer).setEconomicsGovernable(true))
        .to.emit(game, "EconomicsGovernableSet")
        .withArgs(true);
      const newMin = 2n * 10n ** 18n;
      await expect(game.connect(deployer).setMinBet(newMin))
        .to.emit(game, "MinBetUpdated")
        .withArgs(newMin);
      expect(await game.minBet()).to.equal(newMin);
    });

    it("with the flag on, a direct (non-timelock) economic change reverts; a timelock-queued one succeeds", async () => {
      const { game, deployer, timelock, safe } = await deploy();
      // Enable while still deployer-governed, then hand governance to the timelock.
      await game.connect(deployer).setEconomicsGovernable(true);
      await handOff(game, deployer, timelock, safe);

      // Direct call from the Safe (not the timelock) is rejected.
      await expect(game.connect(safe).setMinBet(3n * 10n ** 18n)).to.be.revertedWithCustomError(
        game,
        "NotGovernance",
      );

      // The same change, queued through the timelock, lands after the delay.
      const newMin = 3n * 10n ** 18n;
      const data = game.interface.encodeFunctionData("setMinBet", [newMin]);
      await timelockExec(timelock, safe, await game.getAddress(), data);
      expect(await game.minBet()).to.equal(newMin);
    });

    it("governance can re-lock the economics", async () => {
      const { game, deployer } = await deploy();
      await game.connect(deployer).setEconomicsGovernable(true);
      await game.connect(deployer).setEconomicsGovernable(false);
      await expect(
        game.connect(deployer).setMinBet(2n * 10n ** 18n),
      ).to.be.revertedWithCustomError(game, "EconomicsLocked");
    });

    it("setEconomicsGovernable itself is governance-only", async () => {
      const { game, outsider } = await deploy();
      await expect(
        game.connect(outsider).setEconomicsGovernable(true),
      ).to.be.revertedWithCustomError(game, "NotGovernance");
    });

    it("a governed minBet change takes effect in placeBet validation", async () => {
      const { game, deployer, player } = await deploy();
      await game.connect(deployer).setEconomicsGovernable(true);
      const newMin = 500n * 10n ** 18n;
      await game.connect(deployer).setMinBet(newMin);
      // A stake below the new floor is now rejected; at/above it is accepted.
      await expect(
        game.connect(player).placeBet(COINFLIP_TIER, newMin - 1n, 1n),
      ).to.be.revertedWithCustomError(game, "BetBelowMin");
      await expect(game.connect(player).placeBet(COINFLIP_TIER, newMin, 1n)).to.emit(
        game,
        "BetPlaced",
      );
    });

    it("rejects nonsensical economic values", async () => {
      const { game, deployer } = await deploy();
      await game.connect(deployer).setEconomicsGovernable(true);
      await expect(game.connect(deployer).setMinBet(0)).to.be.revertedWithCustomError(
        game,
        "InvalidEconomics",
      );
      // edge must be a real house edge: 0 < num <= den.
      await expect(game.connect(deployer).setEdge(0, 100)).to.be.revertedWithCustomError(
        game,
        "InvalidEconomics",
      );
      await expect(game.connect(deployer).setEdge(101, 100)).to.be.revertedWithCustomError(
        game,
        "InvalidEconomics",
      );
      await expect(game.connect(deployer).setSolvencyCap(0)).to.be.revertedWithCustomError(
        game,
        "InvalidEconomics",
      );
      // a zero floor would disable the solvency reserve the cap depends on.
      await expect(game.connect(deployer).setTreasuryFloor(0)).to.be.revertedWithCustomError(
        game,
        "InvalidEconomics",
      );
    });

    it("an economic change is blocked while a bet is in flight", async () => {
      // A bet's payout is capped at placeBet against the current edge/cap; the contract
      // forbids changing those out from under an unsettled bet rather than relying on the
      // timelock delay outlasting SETTLE_TIMEOUT.
      const { game, deployer, player } = await deploy();
      await game.connect(deployer).setEconomicsGovernable(true);
      await game.connect(player).placeBet(COINFLIP_TIER, STAKE, 1n);
      await expect(
        game.connect(deployer).setEdge(90n, 100n),
      ).to.be.revertedWithCustomError(game, "EconomicUpdateWhileBetActive");
      await expect(
        game.connect(deployer).setMinBet(2n * 10n ** 18n),
      ).to.be.revertedWithCustomError(game, "EconomicUpdateWhileBetActive");
    });
  });
});
