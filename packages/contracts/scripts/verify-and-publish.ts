import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { artifacts, ethers, network } from "hardhat";
import { CANONICAL_V3_POSITION_MANAGERS } from "./lib/uniswap-v3-stack";
import { type VerificationRequest, verifyContract } from "./lib/blockscout-verify";

/**
 * Verify every deployed contract on Blockscout and publish the address list
 * (#26 AC: "Contracts verified on Blockscout; addresses + verifier published";
 * spec §10.7).
 *
 *   npx hardhat run scripts/verify-and-publish.ts --network robinhoodTestnet
 *
 * Reads deployments/<network>.json - which is gitignored, being a build artefact - and
 * writes docs/deployments/<network>.md, which is committed. That split is deliberate:
 * the JSON is what the relayer and frontend consume, the markdown is the public record
 * a holder can check, and only the latter belongs in git.
 *
 * Verification is idempotent. An already-verified contract reports as such and is
 * counted as a pass rather than an error, so this can be re-run safely.
 */

/** Constructor arguments must match the deploy exactly or Blockscout rejects the source. */
interface VerifyTarget {
  readonly name: string;
  readonly address: string;
  readonly constructorArguments: unknown[];
}

/** The fields of deployments/<network>.json this script reads. */
interface Deployment {
  readonly network: string;
  readonly chainId: number;
  readonly deployer: string;
  readonly rush: string;
  readonly treasury: string;
  readonly game: string;
  readonly vesting: string;
  readonly lpLock: string;
  readonly timelock: string;
  readonly genesisCommit: string;
  readonly relayer: string;
  readonly governanceSafe: string;
  readonly timelockMinDelay: number;
  readonly teamBeneficiary: string;
  readonly vestingStart: number;
  readonly lpUnlockTime: number;
  readonly lpFeeRecipient: string;
  readonly lpPool?: {
    readonly positionManager: string;
    readonly usingMocks: boolean;
    /** RUSH actually seeded into the pool, and the remainder left outside the lock. */
    readonly rushSeeded?: string;
    readonly unseededRush?: string;
  };
}

async function main() {
  const deploymentPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment: Deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));

  if (network.name === "localhost" || network.name === "hardhat") {
    throw new Error("Nothing to verify on a local node - run this against a public network.");
  }

  const targets: VerifyTarget[] = [
    { name: "Rushood", address: deployment.rush, constructorArguments: [deployment.deployer] },
    {
      name: "Treasury",
      address: deployment.treasury,
      constructorArguments: [deployment.rush],
    },
    {
      name: "RushoodGame",
      address: deployment.game,
      constructorArguments: [
        deployment.rush,
        deployment.treasury,
        deployment.genesisCommit,
        deployment.relayer,
      ],
    },
    {
      name: "RushoodVesting",
      address: deployment.vesting,
      constructorArguments: [deployment.teamBeneficiary, deployment.vestingStart],
    },
    {
      name: "RushoodLPLock",
      address: deployment.lpLock,
      constructorArguments: [
        deployment.lpPool?.positionManager,
        deployment.lpFeeRecipient,
        deployment.timelock,
      ],
    },
    {
      name: "RushoodTimelock",
      address: deployment.timelock,
      constructorArguments: [
        deployment.timelockMinDelay,
        [deployment.governanceSafe],
        [deployment.governanceSafe],
        ethers.ZeroAddress,
      ],
    },
  ];

  console.log(`Verifying ${targets.length} contracts on ${network.name}...\n`);
  const verified: string[] = [];
  const failed: string[] = [];

  const explorer = explorerBaseUrl();

  for (const target of targets) {
    try {
      const source = await buildSource(target);
      const outcome = await verifyContract(explorer, source, { fetch: globalThis.fetch });

      if (outcome.state === "verified" || outcome.state === "already-verified") {
        const suffix = outcome.state === "already-verified" ? " (already verified)" : "";
        console.log(`  OK    ${target.name} ${target.address}${suffix}`);
        verified.push(target.name);
      } else {
        const detail = outcome.state === "timeout" ? "timed out waiting for Blockscout" : outcome.message;
        console.log(`  FAIL  ${target.name} ${target.address}\n        ${detail}`);
        failed.push(target.name);
      }
    } catch (error) {
      console.log(
        `  FAIL  ${target.name} ${target.address}\n        ${String((error as Error).message ?? error).split("\n")[0]}`,
      );
      failed.push(target.name);
    }
  }

  const markdown = renderAddressList(deployment, targets, explorer, verified);
  const docsDir = join(__dirname, "..", "..", "..", "docs", "deployments");
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, `${network.name}.md`);
  writeFileSync(docPath, markdown);

  console.log(`\n${verified.length}/${targets.length} verified`);
  console.log(`Address list written to docs/deployments/${network.name}.md`);

  if (failed.length > 0) {
    console.log(`\nFAILED: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * Assemble everything Blockscout needs to recompile a contract exactly as it was deployed.
 *
 * The standard JSON input comes from the *same* Hardhat build-info the deployed artifact
 * was produced by, found through the artifact's `.dbg.json`. Reconstructing the input by
 * hand - or reusing whichever build-info happens to be first on disk - risks recompiling
 * under different settings and producing bytecode that no longer matches the chain.
 */
async function buildSource(target: VerifyTarget): Promise<VerificationRequest> {
  const artifact = await artifacts.readArtifact(target.name);
  const artifactDir = join(__dirname, "..", "artifacts", artifact.sourceName);
  const dbgPath = join(artifactDir, `${artifact.contractName}.dbg.json`);
  const dbg = JSON.parse(readFileSync(dbgPath, "utf8"));
  const buildInfo = JSON.parse(readFileSync(resolve(dirname(dbgPath), dbg.buildInfo), "utf8"));

  const optimizer = buildInfo.input.settings?.optimizer ?? { enabled: false, runs: 200 };

  return {
    address: target.address,
    // Fully qualified, so an inherited base with matching bytecode cannot be picked instead.
    contractName: `${artifact.sourceName}:${artifact.contractName}`,
    compilerVersion: `v${buildInfo.solcLongVersion}`,
    standardInput: JSON.stringify(buildInfo.input),
    constructorArgs: new ethers.Interface(artifact.abi).encodeDeploy(
      target.constructorArguments as never[],
    ),
    optimizer: { enabled: Boolean(optimizer.enabled), runs: Number(optimizer.runs ?? 200) },
  };
}

/**
 * Report the launch-checklist result, or say plainly that it has not been run.
 *
 * Absence is reported rather than omitted: a page that simply leaves the section out
 * reads as "fine" to someone skimming, when the honest statement is "unknown".
 */
function checklistLine(): string {
  const path = join(__dirname, "..", "deployments", `checklist-${network.name}.json`);
  if (!existsSync(path)) {
    return "**Not run against this deployment.** Run `scripts/launch-checklist.ts` - until it\npasses, nothing here has been exercised end to end.";
  }

  const run = JSON.parse(readFileSync(path, "utf8"));
  const when = String(run.ranAt ?? "").slice(0, 10);
  if (run.passed === run.total) {
    return `**${run.passed}/${run.total} checks passed** (${when}) - play across all six tiers, the
public fairness verifier, bet caps, guardian pause/unpause, and the relayer-down refund
after a real \`SETTLE_TIMEOUT\` wait.`;
  }
  return `**${run.passed}/${run.total} checks passed** (${when}). FAILED: ${(run.failures ?? []).join(", ")}`;
}

/**
 * Describe what the lock actually holds - including what it does not.
 *
 * The genesis split allocates 25% to liquidity, and on a full launch all of it is seeded
 * and locked. A scaled-down run seeds only part of it (`LP_ETH_AMOUNT` sets the ETH side
 * and the RUSH side follows at the pinned price), and `deploy-launch.ts` hands the
 * remainder to the Safe, *outside* the lock. Stating "liquidity is held by RushoodLPLock"
 * without that qualifier would describe a 2-year lock over a fraction of the tokens a
 * reader would reasonably assume it covers - on this testnet run, 0.2% of the bucket.
 *
 * The unlocked remainder is the single most consequential number on this page for anyone
 * judging supply overhang, so it is stated in the same breath as the lock rather than
 * left to be reconstructed from the deployment JSON, which is not even committed.
 */
function liquidityCommitment(deployment: Deployment, unlock: string): string {
  const locked =
    " is held by `RushoodLPLock` - the position cannot be withdrawn before\n" +
    `  **${unlock}**. The contract exposes no approve, no liquidity decrease and no call\n` +
    "  forwarder, so the position cannot leave by any other route. Call `isLocked()` to confirm.";

  const unseeded = BigInt(deployment.lpPool?.unseededRush ?? "0");
  if (unseeded === 0n) return locked;

  const seeded = BigInt(deployment.lpPool?.rushSeeded ?? "0");
  return (
    `${locked}\n` +
    `  **Only ${formatRush(seeded)} RUSH of the 250,000,000 liquidity allocation is in that\n` +
    `  position.** The remaining ${formatRush(unseeded)} RUSH was sent to the Safe\n` +
    `  (\`${deployment.governanceSafe}\`) and is **not** locked - treat it as\n` +
    "  circulating overhang, not as committed liquidity."
  );
}

/** Whole-token RUSH with thousands separators; the wei tail is noise at these sizes. */
function formatRush(wei: bigint): string {
  return (wei / 10n ** 18n).toLocaleString("en-US");
}

/**
 * Say so when the pool is not on the chain's canonical Uniswap.
 *
 * Testnet 46630 has no Uniswap v3, so the rehearsal deploys its own factory and position
 * manager. A pool there is real - real bytecode, real balances, real price - but nothing
 * on the chain indexes it, and a reader who assumed otherwise would draw exactly the
 * wrong conclusion about how tradeable the token is. Silence here would be the misleading
 * option, so the provenance is stated rather than left to be inferred from an address.
 */
function uniswapProvenanceNote(deployment: Deployment): string {
  const manager = deployment.lpPool?.positionManager;
  if (!manager || deployment.lpPool?.usingMocks) return "";

  const canonical = CANONICAL_V3_POSITION_MANAGERS[deployment.chainId];
  if (canonical && canonical.toLowerCase() === manager.toLowerCase()) return "";

  return (
    `\n> **Self-deployed Uniswap v3.** This chain has no canonical Uniswap v3 deployment, so\n` +
    `> one was stood up for this rehearsal (position manager \`${manager}\`, via\n` +
    `> \`scripts/deploy-uniswap-v3.ts\`). The pool is genuine, but no router, aggregator or\n` +
    `> price feed on this chain indexes it - do not read the liquidity as tradeable depth.\n`
  );
}

function explorerBaseUrl(): string {
  if (network.config.chainId === 46630) {
    return process.env.BLOCKSCOUT_TESTNET_URL ?? "https://explorer.testnet.chain.robinhood.com";
  }
  return process.env.BLOCKSCOUT_MAINNET_URL ?? "https://robinhoodchain.blockscout.com";
}

/**
 * The public record. Deliberately states what is *not* done as well as what is - a
 * published address list that implied the pre-mainnet audit, legal and trademark gates
 * were cleared would be actively misleading.
 */
function renderAddressList(
  deployment: Deployment,
  targets: VerifyTarget[],
  explorer: string,
  verified: string[],
): string {
  const rows = targets
    .map((t) => {
      const status = verified.includes(t.name) ? "verified" : "NOT VERIFIED";
      return `| \`${t.name}\` | [\`${t.address}\`](${explorer}/address/${t.address}) | ${status} |`;
    })
    .join("\n");

  const unlock = new Date(Number(deployment.lpUnlockTime) * 1000).toISOString().slice(0, 10);
  const cliff = new Date((Number(deployment.vestingStart) + 180 * 86400) * 1000)
    .toISOString()
    .slice(0, 10);

  return `# RUSHOOD deployment - ${deployment.network} (chain ${deployment.chainId})

Generated by \`scripts/verify-and-publish.ts\`. Addresses are canonical; verify each
against the explorer rather than trusting this file.

## Contracts

| Contract | Address | Source |
|---|---|---|
${rows}

## Token

- **Supply** 1,000,000,000 RUSH, minted once, no mint function exists.
- **Genesis split** 45% treasury / 25% liquidity / 15% community / 10% team / 5% staking.

## Commitments a holder can check on-chain

- **Team allocation** is held by \`RushoodVesting\` - nothing releasable until **${cliff}**
  (6-month cliff), then linear to fully vested at month 24.
- **Liquidity**${liquidityCommitment(deployment, unlock)}
- **Governance** of the game's parameters is the Timelock at
  \`${deployment.timelock}\`, proposed and executed by the Safe.

## Fairness

Every settled roll is independently recomputable from its event data using the
open-source verifier in \`packages/verifier\`. The in-app panel is at \`/verify\`.

## Launch checklist

${checklistLine()}

## Status

This is a **${deployment.chainId === 4663 ? "mainnet" : "testnet"}** deployment.

> **Not a launch clearance.** The pre-mainnet gates named in the spec - security audit
> and formal verification, gambling/regulatory clearance, and trademark review of the
> RUSHOOD name - are owner-owned and are **not** implied by anything in this file.
${deployment.lpPool?.usingMocks ? "\n> **Uniswap was mocked in this deployment** - the liquidity figures do not describe a real pool.\n" : ""}${uniswapProvenanceNote(deployment)}
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
