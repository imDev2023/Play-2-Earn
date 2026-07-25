import { expect } from "chai";
import { ethers } from "hardhat";

const COINFLIP_TIER = 0; // 1-in-2
const BET_AMOUNT = 100n * 10n ** 18n;
// Coinflip payout is 0.95 x 2 = 1.9x (5% edge), not the old zero-edge 2x.
const PAYOUT = (BET_AMOUNT * 95n * 2n) / 100n;
const NET_WIN = PAYOUT - BET_AMOUNT; // player's net gain / treasury's net loss on a win
const TREASURY_FUNDING = 100_000n * 10n ** 18n;
const PLAYER_FUNDING = 1_000n * 10n ** 18n;

/** Mirror of the on-chain outcome: win when keccak256(reveal, clientSeed) is even. */
function isWin(reveal: string, clientSeed: bigint): boolean {
  const outcome = BigInt(
    ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [reveal, clientSeed])),
  );
  return outcome % 2n === 0n;
}

/** Smallest clientSeed (from 0) producing the desired win/loss for a reveal. */
function seedForOutcome(reveal: string, wantWin: boolean): bigint {
  for (let i = 0n; i < 1000n; i++) {
    if (isWin(reveal, i) === wantWin) return i;
  }
  throw new Error("no seed found");
}

describe("Walking skeleton — Treasury + RushoodGame", () => {
  async function deploy() {
    const [deployer, player, relayer, outsider] = await ethers.getSigners();

    // Server hash-chain: commit0 = keccak(reveal1), reveal1 = keccak(reveal2), ...
    const reveal3 = ethers.encodeBytes32String("rushood-seed-3");
    const reveal2 = ethers.keccak256(reveal3);
    const reveal1 = ethers.keccak256(reveal2);
    const commit0 = ethers.keccak256(reveal1);

    const Rushood = await ethers.getContractFactory("Rushood");
    const rush = await Rushood.deploy(deployer.address);

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(await rush.getAddress());

    const Game = await ethers.getContractFactory("RushoodGame");
    const game = await Game.deploy(
      await rush.getAddress(),
      await treasury.getAddress(),
      commit0,
      relayer.address,
    );

    await treasury.setGame(await game.getAddress());

    // Fund the treasury (covers winnings) and the player (stakes).
    await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING);
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return {
      rush,
      treasury,
      game,
      deployer,
      player,
      relayer,
      outsider,
      reveals: { reveal1, reveal2, commit0 },
    };
  }

  describe("Treasury authorization", () => {
    it("wires the game exactly once", async () => {
      const { treasury, game, deployer } = await deploy();
      expect(await treasury.game()).to.equal(await game.getAddress());
      await expect(treasury.setGame(deployer.address)).to.be.revertedWithCustomError(
        treasury,
        "GameAlreadySet",
      );
    });

    it("only the game can pay from the treasury", async () => {
      const { treasury, outsider, player } = await deploy();
      await expect(
        treasury.connect(outsider).pay(player.address, BET_AMOUNT),
      ).to.be.revertedWithCustomError(treasury, "NotGame");
    });

    it("rejects setGame from a non-deployer", async () => {
      const Rushood = await ethers.getContractFactory("Rushood");
      const [deployer, other] = await ethers.getSigners();
      const rush = await Rushood.deploy(deployer.address);
      const Treasury = await ethers.getContractFactory("Treasury");
      const treasury = await Treasury.deploy(await rush.getAddress());
      await expect(
        treasury.connect(other).setGame(other.address),
      ).to.be.revertedWithCustomError(treasury, "NotDeployer");
    });
  });

  describe("bet lifecycle", () => {
    it("locks the stake into the treasury on placeBet", async () => {
      const { rush, treasury, game, player } = await deploy();
      const clientSeed = 42n;
      await expect(game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, clientSeed))
        .to.emit(game, "BetPlaced")
        .withArgs(1n, player.address, COINFLIP_TIER, BET_AMOUNT, clientSeed);
      expect(await rush.balanceOf(player.address)).to.equal(PLAYER_FUNDING - BET_AMOUNT);
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(
        TREASURY_FUNDING + BET_AMOUNT,
      );
      expect(await game.activeBetId()).to.equal(1n);
    });

    it("rejects a second bet while one is active", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await expect(
        game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 2n),
      ).to.be.revertedWithCustomError(game, "BetAlreadyActive");
    });

    it("pays 1.9x (0.95 x 2) from the treasury on a winning settle and advances the chain", async () => {
      const { rush, treasury, game, player, relayer, reveals } = await deploy();
      const clientSeed = seedForOutcome(reveals.reveal1, true);
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, clientSeed);

      await expect(game.connect(relayer).settleBet(reveals.reveal1))
        .to.emit(game, "BetSettled")
        .withArgs(1n, player.address, true, PAYOUT);

      // Player: -stake on bet, +1.9*stake on win => net +0.9*stake.
      expect(await rush.balanceOf(player.address)).to.equal(PLAYER_FUNDING + NET_WIN);
      // Treasury: +stake on bet, -1.9*stake on payout => net -0.9*stake.
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(
        TREASURY_FUNDING - NET_WIN,
      );
      expect(await game.currentCommit()).to.equal(reveals.reveal1);
      expect(await game.activeBetId()).to.equal(0n);
    });

    it("keeps the stake in the treasury on a losing settle", async () => {
      const { rush, treasury, game, player, relayer, reveals } = await deploy();
      const clientSeed = seedForOutcome(reveals.reveal1, false);
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, clientSeed);

      await expect(game.connect(relayer).settleBet(reveals.reveal1))
        .to.emit(game, "BetSettled")
        .withArgs(1n, player.address, false, 0n);

      expect(await rush.balanceOf(player.address)).to.equal(PLAYER_FUNDING - BET_AMOUNT);
      expect(await rush.balanceOf(await treasury.getAddress())).to.equal(
        TREASURY_FUNDING + BET_AMOUNT,
      );
      expect(await game.currentCommit()).to.equal(reveals.reveal1);
    });

    it("supports a second round using the advanced chain head", async () => {
      const { game, player, relayer, reveals } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 1n);
      await game.connect(relayer).settleBet(reveals.reveal1);
      // Round 2: reveal2 hashes to reveal1 (the new head).
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 2n);
      await expect(game.connect(relayer).settleBet(reveals.reveal2)).to.emit(
        game,
        "BetSettled",
      );
      expect(await game.currentCommit()).to.equal(reveals.reveal2);
    });
  });

  describe("reveal verification", () => {
    it("reverts settle on a non-matching reveal and leaves the bet active", async () => {
      const { game, player, relayer } = await deploy();
      await game.connect(player).placeBet(COINFLIP_TIER, BET_AMOUNT, 7n);
      const wrong = ethers.encodeBytes32String("not-the-reveal");
      await expect(game.connect(relayer).settleBet(wrong)).to.be.revertedWithCustomError(
        game,
        "InvalidReveal",
      );
      expect(await game.activeBetId()).to.equal(1n);
    });

    it("reverts settle when there is no active bet", async () => {
      const { game, relayer, reveals } = await deploy();
      await expect(
        game.connect(relayer).settleBet(reveals.reveal1),
      ).to.be.revertedWithCustomError(game, "NoActiveBet");
    });
  });
});
