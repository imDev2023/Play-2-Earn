/**
 * Gas harness for issue #47: measures real `gasUsed` for placeBet and settleBet.
 *
 * Deliberately deterministic so a before/after comparison is apples to apples:
 * fixed funding, fixed stake, fixed tier, and a win/loss alternation driven by the
 * same seed search the tests use. Run this on a clean tree, then again after the
 * packing change, and diff the two reports.
 *
 * Runs against the in-process Hardhat network, so no node needs to be up:
 *   npx hardhat run scripts/gas-baseline.ts
 */
import { ethers } from "hardhat";
import { seedForOutcome as seedFor } from "@rushood/verifier";
import type { Hex } from "@rushood/verifier";
import { buildHashChain } from "./lib/hashchain";

const ROUNDS = 13;
const TIER = 0; // coinflip
const STAKE = 100n * 10n ** 18n;
const TREASURY_FUNDING = 1_000_000n * 10n ** 18n;
const PLAYER_FUNDING = 100_000n * 10n ** 18n;

function stats(xs: bigint[]) {
  const sum = xs.reduce((a, b) => a + b, 0n);
  return {
    avg: sum / BigInt(xs.length),
    min: xs.reduce((a, b) => (b < a ? b : a)),
    max: xs.reduce((a, b) => (b > a ? b : a)),
  };
}

async function main() {
  const [deployer, player, relayer] = await ethers.getSigners();
  const chain = buildHashChain("gas-baseline-47", ROUNDS + 2);

  const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
  const treasury = await (
    await ethers.getContractFactory("Treasury")
  ).deploy(await rush.getAddress());
  const game = await (
    await ethers.getContractFactory("RushoodGame")
  ).deploy(await rush.getAddress(), await treasury.getAddress(), chain[0], relayer.address);

  await treasury.setGame(await game.getAddress());
  await rush.transfer(await treasury.getAddress(), TREASURY_FUNDING);
  await rush.transfer(player.address, PLAYER_FUNDING);
  await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);

  const place: bigint[] = [];
  const settleWin: bigint[] = [];
  const settleLoss: bigint[] = [];
  const settleAll: bigint[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const betId = BigInt(round + 1);
    const reveal = chain[round + 1];
    const wantWin = round % 2 === 0;
    const seed = seedFor({ betId, tier: TIER, serverReveal: reveal as Hex }, wantWin, 100_000n);

    const placeRcpt = await (await game.connect(player).placeBet(TIER, STAKE, seed)).wait();
    const settleRcpt = await (await game.connect(relayer).settleBet(reveal)).wait();

    place.push(placeRcpt!.gasUsed);
    settleAll.push(settleRcpt!.gasUsed);
    (wantWin ? settleWin : settleLoss).push(settleRcpt!.gasUsed);
  }

  const p = stats(place);
  const s = stats(settleAll);
  const sw = stats(settleWin);
  const sl = stats(settleLoss);

  console.log(`\nsamples: ${ROUNDS}  tier: ${TIER}  stake: ${STAKE / 10n ** 18n} RUSH`);
  console.log("---------------------------------------------------------------");
  console.log(`placeBet          avg ${p.avg}  min ${p.min}  max ${p.max}`);
  console.log(`settleBet (all)   avg ${s.avg}  min ${s.min}  max ${s.max}`);
  console.log(`settleBet (win)   avg ${sw.avg}  min ${sw.min}  max ${sw.max}`);
  console.log(`settleBet (loss)  avg ${sl.avg}  min ${sl.min}  max ${sl.max}`);
  console.log(`round trip        avg ${p.avg + s.avg}`);
  console.log("---------------------------------------------------------------");
  console.log(`placeBet samples:  ${place.join(", ")}`);
  console.log(`settleBet samples: ${settleAll.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
