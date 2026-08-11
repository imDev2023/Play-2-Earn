import { expect } from "chai";
import { ethers } from "hardhat";
import { buildHashChain } from "../scripts/lib/hashchain";

/**
 * Storage packing, proved against the chain rather than against the source (#47).
 *
 * The packing in `RushoodGame` is a gas claim, and a gas claim that nothing pins is one
 * insertion away from quietly reverting: dropping a `uint256` in the middle of the
 * economic block, or widening one field, unpacks the slot and costs an extra cold
 * `SLOAD` per read with no test going red and no diff that looks wrong. #48 packed the
 * `Bet` struct and the counter pair on exactly such an unpinned claim.
 *
 * So these tests read raw slots with `eth_getStorage` and assert the packed word, which
 * is the only evidence that survives a refactor. Reading the declaration back out of the
 * .sol file would just be restating the thing under test.
 */
describe("Storage packing holds", () => {
  /** Deliberately extreme, distinct, and mostly above 2^48, so a slot that merely looks
   *  right by coincidence cannot pass and a field secretly narrower than 56 bits fails. */
  const EDGE_NUM = 9_007_199_254_740_993n; // 2^53 + 1
  const EDGE_DEN = 36_028_797_018_963_967n; // 2^55 - 1
  const CAP_DEN = 72_057_594_037_927_935n; // 2^56 - 1, the ceiling the setter allows
  const BURN_BPS = 1_000n; // MAX_BURN_RATE_BPS

  async function deploy() {
    const [deployer, player, relayer] = await ethers.getSigners();
    const chain = buildHashChain("storage-packing-test", 8);

    const rush = await (await ethers.getContractFactory("Rushood")).deploy(deployer.address);
    const treasury = await (
      await ethers.getContractFactory("Treasury")
    ).deploy(await rush.getAddress());
    const game = await (
      await ethers.getContractFactory("RushoodGame")
    ).deploy(await rush.getAddress(), await treasury.getAddress(), chain[0], relayer.address);

    await treasury.setGame(await game.getAddress());
    await rush.transfer(await treasury.getAddress(), 1_000_000n * 10n ** 18n);
    await rush.transfer(player.address, 100_000n * 10n ** 18n);
    await rush.connect(player).approve(await game.getAddress(), ethers.MaxUint256);
    return { rush, treasury, game, deployer, player, relayer, chain };
  }

  /** Every slot in [0, depth) as a bigint, for scanning. */
  async function readSlots(address: string, depth = 24): Promise<bigint[]> {
    const slots: bigint[] = [];
    for (let i = 0; i < depth; i++) {
      slots.push(BigInt(await ethers.provider.getStorage(address, i)));
    }
    return slots;
  }

  it("keeps the five economic parameters in one slot, in declaration order", async () => {
    const { game } = await deploy();
    const address = await game.getAddress();

    await game.setEconomicsGovernable(true);
    await game.setEdge(EDGE_NUM, EDGE_DEN);
    await game.setSolvencyCap(CAP_DEN);
    await game.setBurnRate(BURN_BPS);

    // Sanity: the getters agree, so the values really did land (and did not truncate).
    expect(await game.economicsGovernable()).to.equal(true);
    expect(await game.edgeNum()).to.equal(EDGE_NUM);
    expect(await game.edgeDen()).to.equal(EDGE_DEN);
    expect(await game.solvencyCapDen()).to.equal(CAP_DEN);
    expect(await game.burnRateBps()).to.equal(BURN_BPS);

    // Solidity fills a shared slot from the low-order end, in declaration order:
    // economicsGovernable (1 byte), then four uint56s.
    const expected =
      1n | (EDGE_NUM << 8n) | (EDGE_DEN << 64n) | (CAP_DEN << 120n) | (BURN_BPS << 176n);

    const slots = await readSlots(address);
    const matches = slots.filter((word) => word === expected);

    expect(
      matches.length,
      `no single slot held all five economic parameters; slots were ${slots
        .map((s, i) => `${i}:0x${s.toString(16)}`)
        .join(" ")}`,
    ).to.equal(1);

    // And the block ends exactly at the slot boundary rather than spilling into the
    // next one. `currentCommit` is declared immediately after `burnRateBps`, so it must
    // sit in the very next slot; if any economic field had overflowed the word, the
    // compiler would have pushed currentCommit one slot further along. Read off the
    // chain and compared against the getter, so this can actually fail - asserting
    // something about `expected`, which this test builds itself, could not.
    const packedAt = slots.indexOf(expected);
    expect(BigInt(await game.currentCommit())).to.equal(slots[packedAt + 1]);
  });

  it("computes maxBet at the extremes the setters now permit", async () => {
    // The regression guard for the widening cast in `maxBet`. `solvencyCapDen * edgeNum`
    // is uint56 * uint56, which Solidity evaluates in uint56; at these (settable) values
    // that product is ~2^109, so without the cast to uint256 this call reverts on
    // overflow and takes every `placeBet` down with it.
    const { game } = await deploy();

    await game.setEconomicsGovernable(true);
    await game.setEdge(EDGE_NUM, EDGE_DEN);
    await game.setSolvencyCap(CAP_DEN);

    for (let tier = 0; tier < 6; tier++) {
      await expect(game.maxBet(tier), `tier ${tier}`).to.not.be.reverted;
    }
  });

  it("rejects economic ratios too large for the packed storage instead of truncating", async () => {
    const { game } = await deploy();
    const tooBig = (await game.MAX_ECONOMIC_RATIO()) + 1n;

    await game.setEconomicsGovernable(true);

    await expect(game.setEdge(1, tooBig)).to.be.revertedWithCustomError(game, "InvalidEconomics");
    await expect(game.setSolvencyCap(tooBig)).to.be.revertedWithCustomError(
      game,
      "InvalidEconomics",
    );

    // The boundary itself is still accepted, so the bound rejects only what cannot fit.
    await expect(game.setSolvencyCap(await game.MAX_ECONOMIC_RATIO())).to.not.be.reverted;
  });

  it("keeps betCounter and activeBetId in one slot", async () => {
    // #48's half of the same issue, pinned here for the same reason.
    const { game, player } = await deploy();
    const address = await game.getAddress();

    await game.connect(player).placeBet(0, 100n * 10n ** 18n, 12345n);

    const counter = await game.betCounter();
    const active = await game.activeBetId();
    expect(counter).to.equal(1n);
    expect(active).to.equal(1n);

    const expected = counter | (active << 128n);
    const slots = await readSlots(address);
    expect(slots.filter((word) => word === expected).length).to.equal(1);
  });
});
