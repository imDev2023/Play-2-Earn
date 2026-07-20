import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { buildHashChain } from "../scripts/lib/hashchain";
import { settleNextBet, shouldRotate } from "../scripts/lib/relayer-core";

const COINFLIP_TIER = 0; // 1-in-2 tier used for the relayer/refund lifecycle tests
const BET_AMOUNT = 100n * 10n ** 18n;
const TREASURY_FUNDING = 100_000n * 10n ** 18n;
const PLAYER_FUNDING = 1_000n * 10n ** 18n;

describe("Relayer + timeout refund (#19)", () => {
  async function deploy(chainLength = 16) {
    const [deployer, player, relayer, outsider] = await ethers.getSigners();
    const chain = buildHashChain("relayer-refund-test", chainLength);

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

  describe("refund", () => {
    it("returns the stake after the timeout when the relayer never settles", async () => {
      const { rush, treasury, game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      expect(await rush.balanceOf(player.address)).to.equal(PLAYER_FUNDING - BET_AMOUNT);

      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);

      await expect(game.connect(player).refund(1n))
        .to.emit(game, "BetRefunded")
        .withArgs(1n, player.address, BET_AMOUNT);

      expect(await rush.balanceOf(player.address)).to.equal(PLAYER_FUNDING);
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(TREASURY_FUNDING);
      expect(await game.activeBetId()).to.equal(0n);
    });

    it("lets the player place a new bet after a refund (game not bricked)", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await game.connect(player).refund(1n);
      await expect(game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 2n)).to.emit(game, "BetPlaced");
    });

    it("reverts a refund before the timeout", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await expect(game.connect(player).refund(1n)).to.be.revertedWithCustomError(
        game,
        "RefundNotReady",
      );
    });

    it("reverts refunding a non-active bet id", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await expect(game.connect(player).refund(2n)).to.be.revertedWithCustomError(
        game,
        "NotRefundable",
      );
    });

    it("does not advance the chain head on refund", async () => {
      const { game, player, chain } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await time.increase(Number(await game.SETTLE_TIMEOUT()) + 1);
      await game.connect(player).refund(1n);
      expect(await game.currentCommit()).to.equal(chain[0]);
    });
  });

  describe("chain rotation", () => {
    it("lets the relayer rotate to a fresh chain between bets", async () => {
      const { game, relayer } = await deploy();
      const next = buildHashChain("relayer-refund-test:1", 16);
      await expect(game.connect(relayer).rotateChain(next[0]))
        .to.emit(game, "ChainRotated")
        .withArgs(next[0]);
      expect(await game.currentCommit()).to.equal(next[0]);
    });

    it("rejects rotation from a non-relayer", async () => {
      const { game, outsider } = await deploy();
      const next = buildHashChain("x", 16);
      await expect(
        game.connect(outsider).rotateChain(next[0]),
      ).to.be.revertedWithCustomError(game, "NotRelayer");
    });

    it("rejects rotation while a bet is active", async () => {
      const { game, relayer, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      const next = buildHashChain("x", 16);
      await expect(
        game.connect(relayer).rotateChain(next[0]),
      ).to.be.revertedWithCustomError(game, "CannotRotateMidBet");
    });
  });

  describe("shouldRotate (rotation trigger)", () => {
    it("is false mid-chain and true within the margin of the end", () => {
      const chain = buildHashChain("rotation-trigger", 16);
      expect(shouldRotate(chain, chain[1], 2)).to.equal(false); // round 2, far from end
      expect(shouldRotate(chain, chain[13], 2)).to.equal(true); // round 14 >= 16 - 2
      expect(shouldRotate(chain, chain[15], 2)).to.equal(true); // at the end
    });

    it("is false when the head is off this chain", () => {
      const chain = buildHashChain("rotation-trigger", 16);
      const other = buildHashChain("different-seed", 16);
      expect(shouldRotate(chain, other[5], 2)).to.equal(false);
    });
  });

  describe("relayer core against a local node", () => {
    it("settles the active bet by revealing the next chain node", async () => {
      const { rush, game, player, relayer, chain } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 7n);

      const result = await settleNextBet(game.connect(relayer), chain);
      expect(result?.settled).to.equal(true);
      expect(await game.activeBetId()).to.equal(0n);
      expect(await game.currentCommit()).to.equal(chain[1]);
      // Player balance moved by exactly a loss (-stake) or a coinflip win (+0.9*stake).
      const netWin = (BET_AMOUNT * 95n * 2n) / 100n - BET_AMOUNT;
      const bal = await rush.balanceOf(player.address);
      expect([PLAYER_FUNDING - BET_AMOUNT, PLAYER_FUNDING + netWin]).to.include(bal);
    });

    it("returns null when there is no active bet to settle", async () => {
      const { game, relayer, chain } = await deploy();
      expect(await settleNextBet(game.connect(relayer), chain)).to.equal(null);
    });
  });
});
