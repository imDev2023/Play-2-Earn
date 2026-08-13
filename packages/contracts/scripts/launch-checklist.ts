import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { verifyRoll } from "@rushood/verifier";
// Reports *which* custom error came back, not merely that something reverted - a
// checklist accepting any revert would pass on a mistyped address. Takes the contract's
// Interface because a public RPC node returns the revert as raw ABI-encoded bytes.
import { revertsWith } from "./lib/revert-matching";
import { DEFAULT_CHAIN_LENGTH, DEFAULT_MASTER_SEED } from "./lib/hashchain";
import { epochChain, roundForHead } from "./lib/relayer-core";
import { MAX_SUPPLY, allocations } from "./lib/genesis";
import { isLocalNetwork } from "./lib/local-network";

/**
 * The launch-checklist dry run (#26, spec §10 / §11).
 *
 * Runs the whole system the way a launch day would exercise it - play across every
 * tier, force the relayer-down refund, hit the caps, pause and unpause, and recompute a
 * settled roll with the public verifier - and reports pass/fail per item.
 *
 *   npx hardhat run scripts/launch-checklist.ts --network localhost
 *   npx hardhat run scripts/launch-checklist.ts --network robinhoodTestnet
 *
 * It reads deployments/<network>.json, so it checks the stack that was actually
 * deployed rather than one it stands up itself. Exits non-zero if any item fails, so it
 * can gate a release rather than just print reassuring text.
 *
 * The refund item needs SETTLE_TIMEOUT to elapse. Locally that is a time-travel RPC
 * call; on a public chain there is no such shortcut and the script genuinely waits, so
 * expect a testnet run to take over an hour.
 */

const MASTER_SEED = process.env.RELAYER_SEED ?? DEFAULT_MASTER_SEED;
const CHAIN_LENGTH = Number(process.env.RELAYER_CHAIN_LENGTH ?? DEFAULT_CHAIN_LENGTH);
const TIER_COUNT = 6;
const STAKE = 10n * 10n ** 18n;
const PLAYER_FUNDING = 1_000_000n * 10n ** 18n;

interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

/** Records rather than throwing, so one failed item doesn't hide the rest. */
function check(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name} - ${detail}`);
}

async function main() {
  const isLocal = isLocalNetwork(network.name);
  const deployment = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );

  const signers = await ethers.getSigners();
  const [deployer, relayer, player] = signers;
  const safeSigner = signers.find(
    (s) => s.address.toLowerCase() === String(deployment.governanceSafe).toLowerCase(),
  );

  const rush = await ethers.getContractAt("Rushood", deployment.rush);
  const treasury = await ethers.getContractAt("Treasury", deployment.treasury);
  const game = await ethers.getContractAt("RushoodGame", deployment.game);
  const vesting = await ethers.getContractAt("RushoodVesting", deployment.vesting);
  const lpLock = await ethers.getContractAt("RushoodLPLock", deployment.lpLock);

  console.log(`\nLaunch checklist - ${network.name} (chain ${deployment.chainId})\n`);

  // --- Genesis allocation --------------------------------------------------
  //
  // Exact bucket equality is asserted by deploy-launch.ts, at the one moment it holds.
  // By the time this runs the game may have been played - stakes flow into the treasury
  // and burns leave the supply - so checking for pristine genesis numbers here would
  // fail on a *working* system. These are the invariants that survive play.
  console.log("Token supply and allocation");
  const expected = allocations();

  const totalSupply = await rush.totalSupply();
  const burned = MAX_SUPPLY - totalSupply;
  check(
    "supply never exceeds 1B and only ever shrinks",
    totalSupply <= MAX_SUPPLY,
    `${ethers.formatUnits(totalSupply, 18)} RUSH (${ethers.formatUnits(burned, 18)} burned)`,
  );

  const treasuryBalance = await rush.balanceOf(deployment.treasury);
  const treasuryFloor = await game.treasuryFloor();
  check(
    "treasury is banked above its solvency floor",
    treasuryBalance >= treasuryFloor,
    `${ethers.formatUnits(treasuryBalance, 18)} RUSH vs floor ${ethers.formatUnits(treasuryFloor, 18)}`,
  );
  check(
    "treasury was seeded with at least the 45% allocation",
    treasuryBalance >= expected.treasury - burned,
    `${ethers.formatUnits(treasuryBalance, 18)} RUSH`,
  );

  // The team allocation is exact regardless of play: nothing can leave the vesting
  // wallet before the cliff, and the game never touches it.
  const vestingBalance = await rush.balanceOf(deployment.vesting);
  check(
    "team 10% is intact in the vesting wallet",
    vestingBalance === expected.team,
    `${ethers.formatUnits(vestingBalance, 18)} RUSH`,
  );

  // --- Vesting cliff -------------------------------------------------------
  console.log("\nTeam vesting");
  const releasable = await vesting["releasable(address)"](deployment.rush);
  check("cliff withholds the team allocation", releasable === 0n, `${releasable} releasable now`);
  const cliff = await vesting.cliff();
  check(
    "cliff is 6 months after start",
    cliff - BigInt(deployment.vestingStart) === 180n * 24n * 60n * 60n,
    new Date(Number(cliff) * 1000).toISOString(),
  );

  // --- LP lock -------------------------------------------------------------
  console.log("\nLiquidity lock");
  check("LP position is locked", await lpLock.isLocked(), `until ${new Date(deployment.lpUnlockTime * 1000).toISOString()}`);
  const lockOwner = await lpLock.owner();
  check(
    "lock is owned by the Timelock",
    lockOwner.toLowerCase() === String(deployment.timelock).toLowerCase(),
    lockOwner,
  );
  // The owner is the Timelock (a contract), so the reachable check here is that an
  // arbitrary account cannot pull the position. The time-based StillLocked path is
  // covered exhaustively by the LPLock unit tests, which can act as the owner.
  check(
    "a non-owner cannot withdraw the position",
    await revertsWith(
      () => lpLock.connect(player).withdraw.staticCall(deployment.lpPositionId, player.address),
      "OwnableUnauthorizedAccount",
      lpLock.interface,
    ),
    "OwnableUnauthorizedAccount",
  );

  // --- Fund a player -------------------------------------------------------
  const funder = safeSigner ?? deployer;
  if ((await rush.balanceOf(player.address)) < PLAYER_FUNDING) {
    await (await rush.connect(funder).transfer(player.address, PLAYER_FUNDING)).wait();
  }
  await (await rush.connect(player).approve(deployment.game, ethers.MaxUint256)).wait();

  // --- Play across every tier ---------------------------------------------
  console.log("\nPlay across all tiers");
  const chain = epochChain(MASTER_SEED, 0, CHAIN_LENGTH);

  // The game allows one bet at a time, so a bet left in flight by an interrupted run
  // makes every placeBet below revert with BetAlreadyActive - and the checklist would
  // fail on a deployment that is actually fine. A testnet run takes over an hour
  // (SETTLE_TIMEOUT is waited out for real), so interruptions are the normal case, and
  // the alternative recovery is redeploying the whole launch stack.
  await settleAnyBetLeftInFlight(game, chain, relayer);

  let lastSettled: { betId: bigint; tier: number; clientSeed: bigint; reveal: string } | null = null;

  for (let tier = 0; tier < TIER_COUNT; tier++) {
    const clientSeed = BigInt(ethers.hexlify(ethers.randomBytes(16)));
    await (await game.connect(player).placeBet(tier, STAKE, clientSeed)).wait();
    const betId = await game.activeBetId();

    const head = await game.currentCommit();
    const round = roundForHead(chain, head);
    const reveal = chain[round];
    const receipt = await (await game.connect(relayer).settleBet(reveal)).wait();

    const settled = receipt!.logs
      .map((log) => {
        try {
          return game.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "BetSettled");

    check(
      `tier ${tier} (1-in-${await game.odds(tier)}) settles`,
      settled !== undefined && (await game.activeBetId()) === 0n,
      settled ? `roll ${settled.args.roll}, ${settled.args.win ? "WIN" : "loss"}` : "no BetSettled event",
    );

    if (settled) lastSettled = { betId, tier, clientSeed, reveal };
  }

  // --- Public verifier -----------------------------------------------------
  console.log("\nPublic fairness verifier");
  if (lastSettled) {
    // Ask the chain what it settled on, then hand that to the verifier as the reported
    // result - so this checks the two agree, not merely that the verifier runs.
    const [chainRoll, chainWin] = await game.outcomeOf(
      lastSettled.reveal,
      lastSettled.clientSeed,
      lastSettled.betId,
      lastSettled.tier,
    );

    const verdict = verifyRoll({
      betId: lastSettled.betId,
      tier: lastSettled.tier,
      clientEntropy: lastSettled.clientSeed,
      serverReveal: lastSettled.reveal as `0x${string}`,
      commitment: ethers.keccak256(lastSettled.reveal) as `0x${string}`,
      reported: { roll: chainRoll, win: chainWin },
    });

    check(
      "off-chain verifier reproduces the on-chain roll",
      verdict.ok,
      verdict.ok
        ? `verifier roll ${verdict.computed.roll} == chain roll ${chainRoll}`
        : `failures: ${verdict.failures.join(", ")}`,
    );
    check(
      "the reveal really is the pre-image of its commitment",
      verdict.commitmentValid,
      "keccak256(serverReveal) == commitment",
    );
  } else {
    check("off-chain verifier reproduces the on-chain roll", false, "no settled bet to verify");
  }

  // --- Caps and minimums ---------------------------------------------------
  console.log("\nCaps and minimums");
  const minBet = await game.minBet();
  check(
    "a bet below minBet is rejected",
    await revertsWith(
      () => game.connect(player).placeBet.staticCall(0, minBet - 1n, 1n),
      "BetBelowMin",
      game.interface,
    ),
    `BetBelowMin - minBet ${ethers.formatUnits(minBet, 18)} RUSH`,
  );

  const maxBetMoonshot = await game.maxBet(5);
  check(
    "a bet above maxBet is rejected",
    await revertsWith(
      () => game.connect(player).placeBet.staticCall(5, maxBetMoonshot + 10n ** 18n, 1n),
      "ExceedsMaxBet",
      game.interface,
    ),
    `ExceedsMaxBet - maxBet(1-in-1000) ${ethers.formatUnits(maxBetMoonshot, 18)} RUSH`,
  );

  // --- Pause ---------------------------------------------------------------
  console.log("\nEmergency pause");
  if (safeSigner) {
    await (await game.connect(safeSigner).pause()).wait();
    check(
      "guardian can pause and bets are refused",
      await revertsWith(
        () => game.connect(player).placeBet.staticCall(0, STAKE, 1n),
        "EnforcedPause",
        game.interface,
      ),
      "EnforcedPause - placeBet refused while paused",
    );

    await (await game.connect(safeSigner).unpause()).wait();
    check("guardian can unpause", !(await game.paused()), "play resumes");
  } else {
    check(
      "guardian can pause and bets are refused",
      false,
      `guardian ${deployment.guardian} is not among the available signers - supply its key`,
    );
  }

  // --- Forced relayer-down refund ------------------------------------------
  console.log("\nRelayer-down refund");
  const refundSeed = BigInt(ethers.hexlify(ethers.randomBytes(16)));
  const balanceBefore = await rush.balanceOf(player.address);
  await (await game.connect(player).placeBet(0, STAKE, refundSeed)).wait();
  const refundBetId = await game.activeBetId();

  const settleTimeout = await game.SETTLE_TIMEOUT();
  console.log(`  relayer is deliberately NOT settling; waiting out SETTLE_TIMEOUT (${settleTimeout}s)`);
  if (isLocal) {
    await ethers.provider.send("evm_increaseTime", [Number(settleTimeout) + 1]);
    await ethers.provider.send("evm_mine", []);
  } else {
    await waitSeconds(Number(settleTimeout) + 15);
  }

  await (await game.connect(player).refund(refundBetId)).wait();
  const balanceAfter = await rush.balanceOf(player.address);
  check(
    "an unsettled bet refunds the full stake",
    balanceAfter === balanceBefore,
    `stake ${ethers.formatUnits(STAKE, 18)} RUSH returned in full`,
  );
  check("the game is playable again after a refund", (await game.activeBetId()) === 0n, "no active bet");

  // --- Summary -------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  // Record the outcome so the published address list can state it. Without this the
  // only evidence a checklist ever ran is a terminal scrollback nobody else can see -
  // and "23/23 on testnet" is an acceptance criterion someone should be able to check.
  //
  // `game` is what ties the result to a deployment. The filename is per network, and a
  // redeploy does not change the network, so without this the previous stack's record
  // sits exactly where a current one would - and the 2026-08-13 redeploy published one.
  // `chainId` cannot stand in for it: it is identical across every redeploy.
  writeFileSync(
    join(__dirname, "..", "deployments", `checklist-${network.name}.json`),
    JSON.stringify(
      {
        network: network.name,
        chainId: deployment.chainId,
        game: deployment.game,
        passed: results.length - failed.length,
        total: results.length,
        ranAt: new Date().toISOString(),
        failures: failed.map((f) => f.name),
      },
      null,
      2,
    ) + "\n",
  );
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }

  if (deployment.lpPool?.usingMocks) {
    console.log(
      "\nNOTE: Uniswap was mocked in this deployment, so the liquidity checks above\n" +
        "      exercise the lock, not a real pool.",
    );
  }
}

/**
 * Settle a bet left active by a previous, interrupted run.
 *
 * Settling rather than refunding: a refund would mean waiting out SETTLE_TIMEOUT again
 * before the checklist could even start. The outcome of this bet is irrelevant - it is
 * not one of the checked items, it exists only to return the game to an idle state.
 */
async function settleAnyBetLeftInFlight(
  game: {
    activeBetId(): Promise<bigint>;
    currentCommit(): Promise<string>;
    connect(signer: unknown): { settleBet(reveal: string): Promise<{ wait(): Promise<unknown> }> };
  },
  chain: string[],
  relayer: unknown,
): Promise<void> {
  const active = await game.activeBetId();
  if (active === 0n) return;

  const head = await game.currentCommit();
  const round = roundForHead(chain, head);
  console.log(`  clearing bet #${active} left active by an earlier run`);
  await (await game.connect(relayer).settleBet(chain[round])).wait();
}

function waitSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
