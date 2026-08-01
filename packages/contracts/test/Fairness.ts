import { expect } from "chai";
import { ethers } from "hardhat";
import type { ContractTransactionReceipt } from "ethers";
import {
  commitmentFor,
  computeRoll,
  parseVerifyInputs,
  seedForOutcome,
  TIER_ODDS,
  verifyQueryParams,
  verifyRoll,
} from "@rushood/verifier";
import type { Hex } from "@rushood/verifier";
import { buildHashChain } from "../scripts/lib/hashchain";

/**
 * #24 - a settled roll must be independently recomputable by anyone from data the
 * chain publishes: the bet id, the player's client entropy, the server reveal, and
 * the commitment the bet was locked against.
 *
 * These tests drive the real contract and then hand the *emitted* values to the
 * public `@rushood/verifier` package - the same module the `/verify` tool and the
 * in-app fairness panel use. If the verifier and the contract ever disagree, this
 * suite fails, which is the whole point: one formula, two implementations, pinned
 * together.
 */

const MIN_BET = 1n * 10n ** 18n;
const STAKE = 100n * 10n ** 18n;
const COINFLIP = 0;
const MOONSHOT = 5;
const PLAYER_FUNDING = 5_000_000n * 10n ** 18n;

describe("Public fairness verifier (#24)", () => {
  async function deploy() {
    const [deployer, player, relayer] = await ethers.getSigners();
    const chain = buildHashChain("fairness-test", 64) as Hex[];

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
    await rush.transfer(await treasury.getAddress(), 1_000_000n * 10n ** 18n);
    await rush.transfer(player.address, PLAYER_FUNDING);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

    return { rush, treasury, game, deployer, player, relayer, chain };
  }

  /** Place and settle one bet, returning everything a public verifier would see. */
  async function playOneBet(tier: number, clientEntropy: bigint, stake = STAKE) {
    const ctx = await deploy();
    const { game, player, chain } = ctx;

    /** The named event from a receipt - what an outside observer reads off the chain. */
    const eventFrom = (receipt: ContractTransactionReceipt | null, name: string) =>
      receipt!.logs
        .map((log) => {
          try {
            return game.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === name)!;

    const placed = await (await game.connect(player).placeBet(tier, stake, clientEntropy)).wait();
    const placedEvent = eventFrom(placed, "BetPlaced");

    const betId = placedEvent.args.betId as bigint;
    const commitment = placedEvent.args.commit as Hex;
    const serverReveal = chain[1];

    const settled = await (await game.settleBet(serverReveal)).wait();
    const settledEvent = eventFrom(settled, "BetSettled");

    return {
      ...ctx,
      betId,
      tier,
      stake,
      clientEntropy,
      commitment,
      serverReveal,
      reportedWin: settledEvent.args.win as boolean,
      reportedRoll: settledEvent.args.roll as bigint,
      reportedReveal: settledEvent.args.reveal as Hex,
    };
  }

  describe("the chain publishes everything a verifier needs", () => {
    it("BetPlaced carries the commitment the bet is locked against", async () => {
      const { game, player, chain } = await deploy();
      await expect(game.connect(player).placeBet(COINFLIP, STAKE, 42n))
        .to.emit(game, "BetPlaced")
        .withArgs(1n, player.address, COINFLIP, STAKE, 42n, chain[0]);
    });

    it("BetSettled carries the server reveal and the roll", async () => {
      const played = await playOneBet(COINFLIP, 42n);
      expect(played.reportedReveal).to.equal(played.serverReveal);
      const expected = computeRoll({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: 42n,
        serverReveal: played.serverReveal,
      });
      expect(played.reportedRoll).to.equal(expected.roll);
    });

    it("bets(betId) still exposes the commitment and reveal after settlement", async () => {
      const played = await playOneBet(COINFLIP, 42n);
      const bet = await played.game.bets(played.betId);
      expect(bet.commit).to.equal(played.commitment);
      expect(bet.reveal).to.equal(played.serverReveal);
      // A record no one has to trust an indexer for: the whole verification input
      // set is readable from one call.
      expect(bet.clientSeed).to.equal(42n);
    });

    it("leaves reveal zeroed on an unsettled bet", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP, STAKE, 42n);
      const bet = await game.bets(1n);
      expect(bet.reveal).to.equal(ethers.ZeroHash);
    });
  });

  describe("the verifier reproduces the on-chain result", () => {
    it("recomputes the roll from betId + clientEntropy + serverReveal alone", async () => {
      const played = await playOneBet(COINFLIP, 12345n);
      const verdict = verifyRoll({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
        commitment: played.commitment,
        reported: { win: played.reportedWin, roll: played.reportedRoll },
      });
      expect(verdict.ok).to.equal(true);
      expect(verdict.commitmentValid).to.equal(true);
      expect(verdict.failures).to.deep.equal([]);
      expect(verdict.computed.win).to.equal(played.reportedWin);
      expect(verdict.computed.roll).to.equal(played.reportedRoll);
    });

    it("agrees with the contract's own pure outcomeOf on every tier", async () => {
      const { game } = await deploy();
      const reveal = ethers.keccak256(ethers.toUtf8Bytes("some-reveal")) as Hex;
      for (let tier = 0; tier < TIER_ODDS.length; tier++) {
        for (let betId = 1n; betId <= 5n; betId++) {
          for (const clientEntropy of [0n, 1n, 7n, 2n ** 200n]) {
            const [roll, win] = await game.outcomeOf(reveal, clientEntropy, betId, tier);
            const computed = computeRoll({ betId, tier, clientEntropy, serverReveal: reveal });
            expect(computed.roll).to.equal(roll);
            expect(computed.win).to.equal(win);
          }
        }
      }
    });

    it("verifies a winning roll and a losing roll alike", async () => {
      const serverReveal = buildHashChain("fairness-test", 64)[1] as Hex;
      for (const wantWin of [true, false]) {
        const seed = seedForOutcome({ betId: 1n, tier: COINFLIP, serverReveal }, wantWin);
        const played = await playOneBet(COINFLIP, seed);
        expect(played.reportedWin).to.equal(wantWin);
        const verdict = verifyRoll({
          betId: played.betId,
          tier: COINFLIP,
          clientEntropy: seed,
          serverReveal: played.serverReveal,
          commitment: played.commitment,
          reported: { win: played.reportedWin, roll: played.reportedRoll },
        });
        expect(verdict.ok).to.equal(true);
        expect(verdict.computed.win).to.equal(wantWin);
      }
    });
  });

  describe("the hash-chain link", () => {
    it("confirms keccak256(serverReveal) equals the committed head", async () => {
      const played = await playOneBet(COINFLIP, 42n);
      expect(commitmentFor(played.serverReveal)).to.equal(played.commitment);
    });

    it("rejects a reveal that is not the pre-image of the commitment", async () => {
      const played = await playOneBet(COINFLIP, 42n);
      const verdict = verifyRoll({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: played.clientEntropy,
        serverReveal: ethers.keccak256(ethers.toUtf8Bytes("not-the-reveal")) as Hex,
        commitment: played.commitment,
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.commitmentValid).to.equal(false);
      expect(verdict.failures).to.include("commitment-mismatch");
    });

    it("the contract rejects the same forged reveal", async () => {
      const { game, player } = await deploy();
      await game.connect(player).placeBet(COINFLIP, STAKE, 42n);
      await expect(
        game.settleBet(ethers.keccak256(ethers.toUtf8Bytes("not-the-reveal"))),
      ).to.be.revertedWithCustomError(game, "InvalidReveal");
    });
  });

  describe("tamper detection", () => {
    /**
     * The first substitution of `field` that actually moves the draw. A forgery that
     * happens to land on the same roll isn't a forgery of anything - searching for one
     * that does keeps these tests deterministic instead of relying on a lucky seed.
     */
    function forge(
      truth: { betId: bigint; tier: number; clientEntropy: bigint; serverReveal: Hex },
      field: "betId" | "clientEntropy",
    ) {
      const truthRoll = computeRoll(truth).roll;
      for (let delta = 1n; delta < 1000n; delta++) {
        const forged = { ...truth, [field]: truth[field] + delta };
        if (computeRoll(forged).roll !== truthRoll) return forged;
      }
      throw new Error(`no ${field} substitution changed the roll`);
    }

    it("a substituted clientEntropy no longer reproduces the reported roll", async () => {
      const played = await playOneBet(MOONSHOT, 42n, MIN_BET);
      const truth = {
        betId: played.betId,
        tier: MOONSHOT,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
      };
      const verdict = verifyRoll({
        ...forge(truth, "clientEntropy"),
        commitment: played.commitment,
        reported: { roll: played.reportedRoll },
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.failures).to.include("roll-mismatch");
    });

    it("a substituted betId no longer reproduces the reported roll", async () => {
      const played = await playOneBet(MOONSHOT, 42n, MIN_BET);
      const truth = {
        betId: played.betId,
        tier: MOONSHOT,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
      };
      const verdict = verifyRoll({
        ...forge(truth, "betId"),
        commitment: played.commitment,
        reported: { roll: played.reportedRoll },
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.failures).to.include("roll-mismatch");
    });

    it("a claimed win the roll does not support is caught", async () => {
      const played = await playOneBet(COINFLIP, 42n);
      const verdict = verifyRoll({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
        commitment: played.commitment,
        reported: { win: !played.reportedWin },
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.failures).to.include("win-mismatch");
    });

    it("rejects a tier outside the published ladder", async () => {
      const reveal = commitmentFor(`0x${"11".repeat(32)}`);
      const verdict = verifyRoll({
        betId: 1n,
        tier: 6,
        clientEntropy: 42n,
        serverReveal: reveal,
        commitment: commitmentFor(reveal),
      });
      expect(verdict.ok).to.equal(false);
      expect(verdict.failures).to.include("unknown-tier");
    });
  });

  describe("the one-click verify link", () => {
    it("round-trips a real settled bet: chain → link → parse → PASS", async () => {
      // This is the promise the in-app fairness panel makes: the link it hands you
      // carries the whole proof, so whoever opens it verifies from the link itself
      // rather than from a lookup they'd have to trust. Built and parsed by the same
      // module the `/verify` page and the CLI use.
      const played = await playOneBet(COINFLIP, 12345n);
      const query = verifyQueryParams({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
        commitment: played.commitment,
        reported: { win: played.reportedWin, roll: played.reportedRoll },
      });

      // Re-read it exactly as a browser or the CLI would: strings out of a URL.
      const url = new URL(`https://rushood.example/verify?${query.toString()}`);
      const parsed = parseVerifyInputs({
        betId: url.searchParams.get("betId"),
        tier: url.searchParams.get("tier"),
        clientEntropy: url.searchParams.get("clientEntropy"),
        serverReveal: url.searchParams.get("serverReveal"),
        commitment: url.searchParams.get("commitment"),
        win: url.searchParams.get("win"),
        roll: url.searchParams.get("roll"),
      });

      expect(parsed.ok, parsed.ok ? "" : parsed.errors.map((e) => e.message).join("; ")).to.equal(
        true,
      );
      if (!parsed.ok) return;
      const verdict = verifyRoll(parsed.inputs);
      expect(verdict.ok).to.equal(true);
      expect(verdict.computed.win).to.equal(played.reportedWin);
      expect(verdict.computed.roll).to.equal(played.reportedRoll);
    });

    it("a link whose entropy has been edited fails when re-checked", async () => {
      const played = await playOneBet(MOONSHOT, 42n, MIN_BET);
      const query = verifyQueryParams({
        betId: played.betId,
        tier: MOONSHOT,
        clientEntropy: played.clientEntropy,
        serverReveal: played.serverReveal,
        commitment: played.commitment,
        reported: { win: played.reportedWin, roll: played.reportedRoll },
      });
      // Someone forwards a doctored link claiming a different entropy went in.
      query.set("clientEntropy", (played.clientEntropy + 1n).toString());
      const parsed = parseVerifyInputs(Object.fromEntries(query));
      expect(parsed.ok).to.equal(true);
      if (!parsed.ok) return;
      expect(verifyRoll(parsed.inputs).ok).to.equal(false);
    });
  });

  describe("betId is part of the draw", () => {
    it("the same reveal and entropy give different rolls for different bets", async () => {
      const reveal = ethers.keccak256(ethers.toUtf8Bytes("shared-reveal")) as Hex;
      const a = computeRoll({ betId: 1n, tier: 5, clientEntropy: 99n, serverReveal: reveal });
      const b = computeRoll({ betId: 2n, tier: 5, clientEntropy: 99n, serverReveal: reveal });
      // Domain separation: a refunded bet leaves the chain head unadvanced, so the
      // next bet can face the same reveal. Mixing the bet id in keeps an outcome
      // from being replayable across bets.
      expect(a.entropy).to.not.equal(b.entropy);
    });
  });

  describe("min bet stays reachable", () => {
    it("verifies a roll at the minimum stake", async () => {
      const played = await playOneBet(COINFLIP, 7n, MIN_BET);
      const verdict = verifyRoll({
        betId: played.betId,
        tier: COINFLIP,
        clientEntropy: 7n,
        serverReveal: played.serverReveal,
        commitment: played.commitment,
        reported: { win: played.reportedWin, roll: played.reportedRoll },
      });
      expect(verdict.ok).to.equal(true);
    });
  });
});
