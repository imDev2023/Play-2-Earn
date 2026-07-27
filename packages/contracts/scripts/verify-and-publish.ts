import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers, network, run } from "hardhat";

/**
 * Verify every deployed contract on Blockscout and publish the address list
 * (#26 AC: "Contracts verified on Blockscout; addresses + verifier published";
 * spec §10.7).
 *
 *   npx hardhat run scripts/verify-and-publish.ts --network robinhoodTestnet
 *
 * Reads deployments/<network>.json — which is gitignored, being a build artefact — and
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
  readonly lpPool?: { readonly positionManager: string; readonly usingMocks: boolean };
}

async function main() {
  const deploymentPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment: Deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));

  if (network.name === "localhost" || network.name === "hardhat") {
    throw new Error("Nothing to verify on a local node — run this against a public network.");
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

  for (const target of targets) {
    try {
      await run("verify:verify", {
        address: target.address,
        constructorArguments: target.constructorArguments,
      });
      console.log(`  OK    ${target.name} ${target.address}`);
      verified.push(target.name);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (/already verified/i.test(message)) {
        console.log(`  OK    ${target.name} ${target.address} (already verified)`);
        verified.push(target.name);
      } else {
        console.log(`  FAIL  ${target.name} ${target.address}\n        ${message.split("\n")[0]}`);
        failed.push(target.name);
      }
    }
  }

  const explorer = explorerBaseUrl();
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

function explorerBaseUrl(): string {
  if (network.config.chainId === 46630) {
    return process.env.BLOCKSCOUT_TESTNET_URL ?? "https://explorer.testnet.chain.robinhood.com";
  }
  return process.env.BLOCKSCOUT_MAINNET_URL ?? "https://robinhoodchain.blockscout.com";
}

/**
 * The public record. Deliberately states what is *not* done as well as what is — a
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

  return `# RUSHOOD deployment — ${deployment.network} (chain ${deployment.chainId})

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

- **Team allocation** is held by \`RushoodVesting\` — nothing releasable until **${cliff}**
  (6-month cliff), then linear to fully vested at month 24.
- **Liquidity** is held by \`RushoodLPLock\` — the position cannot be withdrawn before
  **${unlock}**. The contract exposes no approve, no liquidity decrease and no call
  forwarder, so the position cannot leave by any other route. Call \`isLocked()\` to confirm.
- **Governance** of the game's parameters is the Timelock at
  \`${deployment.timelock}\`, proposed and executed by the Safe.

## Fairness

Every settled roll is independently recomputable from its event data using the
open-source verifier in \`packages/verifier\`. The in-app panel is at \`/verify\`.

## Status

This is a **${deployment.chainId === 4663 ? "mainnet" : "testnet"}** deployment.

> **Not a launch clearance.** The pre-mainnet gates named in the spec — security audit
> and formal verification, gambling/regulatory clearance, and trademark review of the
> RUSHOOD name — are owner-owned and are **not** implied by anything in this file.
${deployment.lpPool?.usingMocks ? "\n> **Uniswap was mocked in this deployment** — the liquidity figures do not describe a real pool.\n" : ""}
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
