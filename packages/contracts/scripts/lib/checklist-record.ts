/**
 * The launch checklist's result, and whether it is about the deployment being published.
 *
 * `launch-checklist.ts` writes `deployments/checklist-<network>.json`, and
 * `verify-and-publish.ts` reproduces it in the public address list. The two used to be
 * joined only by that filename, and a filename is per *network*, not per deployment - so
 * a record from an earlier stack on the same network sat exactly where a current one
 * would.
 *
 * That is not hypothetical. The 2026-08-13 testnet redeploy published six brand-new
 * addresses under "23/23 checks passed (2026-07-28)", a run against the contracts those
 * addresses had just replaced, because the only test was that the file existed. The
 * checklist for the new stack was still running at the time.
 *
 * `chainId` was already in the record and cannot serve as the join: it is identical
 * across every redeploy of the same chain, which is exactly the case that broke.
 *
 * Both halves of the join live here on purpose. A reader that checks an address the
 * writer never records is a check that can only ever fail, and a writer whose output
 * nothing reads is a check that can only ever pass; splitting them across two scripts is
 * what let the first version ship with the writer untested.
 */

/**
 * The stack a checklist run exercised.
 *
 * All six, not just the game: the run also asserts the vesting cliff, the LP lock's
 * owner, the treasury's balance and the timelock's governance, and `Treasury.setGame`
 * (PR #54) means a game address does not by itself pin the treasury behind it.
 */
export interface StackAddresses {
  readonly rush: string;
  readonly treasury: string;
  readonly game: string;
  readonly vesting: string;
  readonly lpLock: string;
  readonly timelock: string;
}

const STACK_KEYS = ["rush", "treasury", "game", "vesting", "lpLock", "timelock"] as const;

/** Written by `launch-checklist.ts`. Fields are optional because older records exist. */
export interface ChecklistRecord {
  readonly network?: string;
  readonly chainId?: number;
  /** The stack the run exercised. Absent in records written before this was stamped. */
  readonly stack?: Partial<StackAddresses>;
  readonly passed?: number;
  readonly total?: number;
  readonly ranAt?: string;
  readonly failures?: readonly string[];
}

const NOT_RUN =
  "**Not run against this deployment.** Run `scripts/launch-checklist.ts` - until it\n" +
  "passes, nothing here has been exercised end to end.";

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Case-insensitive, because a checksummed address and a lowercased one are the same one. */
function sameAddress(a: unknown, b: unknown): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function sameStack(recorded: Partial<StackAddresses>, deployed: StackAddresses): boolean {
  return STACK_KEYS.every((key) => sameAddress(recorded[key], deployed[key]));
}

/**
 * Build the record `launch-checklist.ts` writes.
 *
 * Kept here rather than inline at the call site so the field the publisher joins on is
 * produced by tested code. Deleting the stamp from an object literal in a script is
 * invisible to every test; deleting it from here is not.
 */
export function buildChecklistRecord(args: {
  readonly network: string;
  readonly chainId: number;
  readonly stack: StackAddresses;
  readonly passed: number;
  readonly total: number;
  readonly failures: readonly string[];
  readonly ranAt?: string;
}): ChecklistRecord {
  return {
    network: args.network,
    chainId: args.chainId,
    stack: {
      rush: args.stack.rush,
      treasury: args.stack.treasury,
      game: args.stack.game,
      vesting: args.stack.vesting,
      lpLock: args.stack.lpLock,
      timelock: args.stack.timelock,
    },
    passed: args.passed,
    total: args.total,
    ranAt: args.ranAt ?? new Date().toISOString(),
    failures: [...args.failures],
  };
}

/**
 * Render the checklist section for the published address list.
 *
 * `record` is the parsed JSON, or null when the file is absent. `deployed` is the stack
 * about to be published. Anything that cannot be tied to `deployed` reports as not run:
 * a passing count must not survive a failed attribution.
 *
 * Absence was already reported rather than omitted, on the reasoning that a missing
 * section reads as "fine" when the honest statement is "unknown". This extends that to
 * the case that looks present and is not.
 */
export function checklistLine(record: ChecklistRecord | null, deployed: StackAddresses): string {
  if (record === null) return NOT_RUN;

  const when = String(record.ranAt ?? "").slice(0, 10);
  const dated = when ? ` from ${when}` : "";

  // An unstamped record cannot be attributed to any deployment, so it cannot vouch for
  // this one. Saying a record exists beats a bare "not run", because the reader is
  // looking at a file that plainly does.
  if (record.stack === undefined) {
    return (
      `${NOT_RUN}\n\n` +
      `A checklist record exists${dated} but does not record which deployment it ran\n` +
      `against, so it cannot vouch for the addresses above.`
    );
  }

  if (!sameStack(record.stack, deployed)) {
    // The recorded game is named to make the mismatch checkable, and marked superseded
    // because this page opens by calling its addresses canonical.
    const other = isAddress(record.stack.game) ? record.stack.game : "an unrecorded address";
    return (
      `${NOT_RUN}\n\n` +
      `The most recent record${dated} ran against a superseded stack\n` +
      `(game \`${other}\`), not the one published above.`
    );
  }

  if (typeof record.passed !== "number" || typeof record.total !== "number") {
    return (
      `${NOT_RUN}\n\n` +
      `A checklist record exists${dated} for these addresses but records no result.`
    );
  }

  if (record.passed === record.total) {
    return `**${record.passed}/${record.total} checks passed** (${when}) - play across all six tiers, the
public fairness verifier, bet caps, guardian pause/unpause, and the relayer-down refund
after a real \`SETTLE_TIMEOUT\` wait.`;
  }
  return `**${record.passed}/${record.total} checks passed** (${when}). FAILED: ${(record.failures ?? []).join(", ")}`;
}
