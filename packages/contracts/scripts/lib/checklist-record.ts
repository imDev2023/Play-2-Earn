/**
 * The launch checklist's result, and whether it is about the deployment being published.
 *
 * `launch-checklist.ts` writes `deployments/checklist-<network>.json`, and
 * `verify-and-publish.ts` reproduces it in the public address list. The two are joined
 * only by that filename, and a filename is per *network*, not per deployment - so a
 * record from an earlier stack on the same network sits exactly where a current one
 * would.
 *
 * That is not hypothetical. The 2026-08-13 testnet redeploy published six brand-new
 * addresses under "23/23 checks passed (2026-07-28)", a run against the contracts those
 * addresses had just replaced, because the only test was that the file existed. The
 * checklist for the new stack was still running at the time.
 *
 * So the record carries the game address it ran against, and a mismatch is reported as
 * "not run" rather than as a pass. Reporting absence loudly is the existing intent here;
 * this extends it to the case that looks present and is not.
 */

/** Written by `launch-checklist.ts`. Every field is optional, because old records exist. */
export interface ChecklistRecord {
  readonly network?: string;
  readonly chainId?: number;
  /** The game address the run exercised. Absent in records written before this stamp. */
  readonly game?: string;
  readonly passed?: number;
  readonly total?: number;
  readonly ranAt?: string;
  readonly failures?: readonly string[];
}

const NOT_RUN =
  "**Not run against this deployment.** Run `scripts/launch-checklist.ts` - until it\n" +
  "passes, nothing here has been exercised end to end.";

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Render the checklist section for the published address list.
 *
 * `record` is the parsed JSON, or null when the file is absent. `deploymentGame` is the
 * game address from the deployment about to be published.
 */
export function checklistLine(record: ChecklistRecord | null, deploymentGame: string): string {
  if (record === null) return NOT_RUN;

  // An unstamped record cannot be attributed to any deployment, so it cannot be used to
  // vouch for this one. Saying which run it was beats a bare "not run", because the
  // reader is looking at a file that plainly does exist.
  if (record.game === undefined) {
    const when = String(record.ranAt ?? "").slice(0, 10);
    return (
      `${NOT_RUN}\n\n` +
      `A checklist record exists${when ? ` from ${when}` : ""} but does not record which ` +
      `deployment it ran\nagainst, so it cannot vouch for the addresses above.`
    );
  }

  if (!sameAddress(record.game, deploymentGame)) {
    const when = String(record.ranAt ?? "").slice(0, 10);
    return (
      `${NOT_RUN}\n\n` +
      `The most recent record${when ? ` (${when})` : ""} ran against \`${record.game}\`, which is ` +
      `not the\ngame deployed here. It describes a stack these addresses replaced.`
    );
  }

  const when = String(record.ranAt ?? "").slice(0, 10);
  if (record.passed === record.total) {
    return `**${record.passed}/${record.total} checks passed** (${when}) - play across all six tiers, the
public fairness verifier, bet caps, guardian pause/unpause, and the relayer-down refund
after a real \`SETTLE_TIMEOUT\` wait.`;
  }
  return `**${record.passed}/${record.total} checks passed** (${when}). FAILED: ${(record.failures ?? []).join(", ")}`;
}
