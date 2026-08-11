import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { GAME_ABI } from "../contracts";
import { edgePercentLabel, formatRush, parseRush, percentLabel } from "./format";

/**
 * The admin operations catalogue - every sensitive change the console can make, what
 * the game will accept, and how a change becomes calldata.
 *
 * Validation deliberately mirrors the contract's own guards. A queued change waits out
 * the timelock delay before the chain ever gets to look at it, so a value the game can
 * never accept has to be caught here: otherwise it surfaces two days later as a
 * reverted execution, with the delay spent and nothing to show for it.
 *
 * The three kinds of constraint are kept apart on purpose:
 *
 *   - **Shape and bounds** (`parseAdminOp`) - what the contract rejects unconditionally
 *     (`InvalidEconomics`, `BurnRateTooHigh`). These block, because no amount of waiting
 *     makes them valid.
 *   - **Current state** (`preflightAdminOp`) - what the contract rejects *right now*
 *     (`EconomicsLocked`, `EconomicUpdateWhileBetActive`, `BurnBelowFloor`). These only
 *     warn: an operation is executed days after it is queued, by which time the economy
 *     may have been unlocked, the bet settled and the treasury grown.
 *   - **Authority** (lib/admin/access.ts) - who is allowed to ask at all.
 *
 * Everything that varies per operation - its fields, its bounds, how it reads back in
 * plain language - lives on its entry in `ADMIN_OPS`, so adding an operation is one
 * edit in one table rather than a new arm in three switches.
 *
 * `setGovernance` and `setGuardian` are deliberately absent. They are governance calls
 * like the rest, but a role handed to a mistyped address is unrecoverable - there is no
 * second key left to correct it - and #25 asks for a parameter console, not a key
 * ceremony. Rotating a role stays a deliberate, scripted operation.
 */

export type AdminOpId =
  | "setBurnRate"
  | "setEconomicsGovernable"
  | "setMinBet"
  | "setEdge"
  | "setSolvencyCap"
  | "setTreasuryFloor"
  | "burnTreasuryProfit";

/**
 * `RushoodGame.MAX_BURN_RATE_BPS` - the ceiling governance may set the burn rate to.
 * A mirror of the on-chain constant, used as the default bound; the console reads the
 * live value and passes it to `parseAdminOp` so a redeployed ceiling wins over this.
 */
export const DEFAULT_MAX_BURN_RATE_BPS = 1_000n;

/**
 * `RushoodGame.MAX_ECONOMIC_RATIO` - the largest value `edgeNum`, `edgeDen` and
 * `solvencyCapDen` can hold now that #47 packed them into one `uint56` slot. Above it
 * `setEdge` and `setSolvencyCap` revert with `InvalidEconomics`.
 *
 * Mirrored as a constant rather than read live, unlike `MAX_BURN_RATE_BPS`: that one is a
 * policy ceiling a redeploy could plausibly retune, whereas this is the width of the
 * storage field itself. It cannot change without a redeploy that also changes the ABI,
 * and `abi-matches-artifact.test.ts` would fail first if it did.
 */
export const MAX_ECONOMIC_RATIO = 72_057_594_037_927_935n; // type(uint56).max

export interface AdminOpField {
  /** Matches the contract's parameter name, so the form and the ABI agree. */
  name: string;
  label: string;
  /**
   * `integer` - a whole number in the contract's own units (bps, a denominator).
   * `rush` - a decimal token amount, converted to wei.
   * `boolean` - a flag.
   */
  kind: "integer" | "rush" | "boolean";
  /** Inclusive lower bound, in the field's on-chain units. */
  min?: bigint;
  /** Inclusive upper bound, in the field's on-chain units. */
  max?: bigint;
  /**
   * Why the upper bound exists, appended to the error so the operator learns the reason
   * rather than just the number. Carried per field rather than baked into the validator:
   * the bounds have different causes - a storage width here, a policy ceiling elsewhere -
   * and a shared message would state the wrong one for the next field that grows a `max`.
   */
  maxReason?: string;
  placeholder?: string;
  hint?: string;
}

export interface OpFieldError {
  field: string;
  message: string;
}

export interface ParseOptions {
  /** The live `MAX_BURN_RATE_BPS`, when the console has read it. */
  maxBurnRateBps?: bigint;
}

export interface AdminGameState {
  economicsGovernable: boolean;
  /** Zero when no bet is in flight. */
  activeBetId: bigint;
  treasuryBalance: bigint;
  treasuryFloor: bigint;
}

export type AdminWarningCode = "economics-locked" | "bet-in-flight" | "burn-exceeds-headroom";

export interface AdminWarning {
  code: AdminWarningCode;
  message: string;
}

export interface AdminOpSpec {
  id: AdminOpId;
  label: string;
  /** What the change does, in one line, for the form. */
  summary: string;
  fields: readonly AdminOpField[];
  /** Reverts with `EconomicsLocked` until `economicsGovernable` is on. */
  needsEconomicsUnlocked: boolean;
  /** Reverts while a bet is in flight. */
  needsIdleGame: boolean;
  /** Constraints spanning more than one field, or needing a live on-chain bound. */
  crossCheck?: (args: readonly unknown[], options: ParseOptions) => OpFieldError[];
  /** The call in plain language, rendered from its decoded arguments. */
  describe: (args: readonly unknown[]) => string;
  /** State-dependent warnings unique to this operation. */
  preflight?: (args: readonly unknown[], state: AdminGameState) => AdminWarning[];
}

export type OpParseResult =
  | { ok: true; args: readonly unknown[] }
  | { ok: false; errors: OpFieldError[] };

/**
 * Every operation, in the order the console lists them: the two knobs that work on a
 * stock deployment first, then the invariants behind the `economicsGovernable` opt-in,
 * then the one operation that moves money.
 */
export const ADMIN_OPS: readonly AdminOpSpec[] = [
  {
    id: "setBurnRate",
    label: "Per-play burn rate",
    summary: "The slice of every settled stake that is burned, win or loss.",
    fields: [
      {
        name: "newBps",
        label: "Burn rate (basis points)",
        kind: "integer",
        min: 0n,
        placeholder: "250",
        hint: "250 bps = 2.5%, the launch setting. Zero switches the per-play burn off.",
      },
    ],
    needsEconomicsUnlocked: false,
    needsIdleGame: false,
    crossCheck: (args, options) => {
      const max = options.maxBurnRateBps ?? DEFAULT_MAX_BURN_RATE_BPS;
      if ((args[0] as bigint) <= max) return [];
      return [
        {
          field: "newBps",
          message: `The burn rate is capped at ${max} bps (${percentLabel(max)}) by MAX_BURN_RATE_BPS`,
        },
      ];
    },
    describe: (args) => {
      const bps = args[0] as bigint;
      return `burn ${bps} bps (${percentLabel(bps)}) of every settled stake`;
    },
  },
  {
    id: "setEconomicsGovernable",
    label: "Economic setters lock",
    summary:
      "The opt-in switch for a governable economy. While off, edge / cap / min-bet / floor are immutable - even for governance.",
    fields: [
      {
        name: "enabled",
        label: "Unlocked",
        kind: "boolean",
        hint: "Turning this on is itself a governed change, so it queues like any other.",
      },
    ],
    needsEconomicsUnlocked: false,
    needsIdleGame: false,
    describe: (args) =>
      (args[0] as boolean)
        ? "unlock the economic setters (edge, cap, min bet, floor)"
        : "re-lock the economic setters",
  },
  {
    id: "setMinBet",
    label: "Minimum bet",
    summary: "The smallest stake the game accepts. Tracks a ~$0.25-0.50 floor in RUSH.",
    fields: [
      {
        name: "newMinBet",
        label: "Minimum bet (RUSH)",
        kind: "rush",
        min: 1n,
        placeholder: "1",
      },
    ],
    needsEconomicsUnlocked: true,
    needsIdleGame: true,
    describe: (args) => `minimum bet → ${formatRush(args[0] as bigint)} RUSH`,
  },
  {
    id: "setEdge",
    label: "House edge",
    summary: "The payout multiplier per unit of odds: a win pays stake × num/den × N.",
    fields: [
      {
        name: "num",
        label: "Numerator",
        kind: "integer",
        min: 1n,
        max: MAX_ECONOMIC_RATIO,
        maxReason: "the game packs it into 56 bits and reverts above that",
        placeholder: "95",
        hint: "95/100 is the flat 5% edge every tier ships with.",
      },
      {
        name: "den",
        label: "Denominator",
        kind: "integer",
        min: 1n,
        max: MAX_ECONOMIC_RATIO,
        maxReason: "the game packs it into 56 bits and reverts above that",
        placeholder: "100",
      },
    ],
    needsEconomicsUnlocked: true,
    needsIdleGame: true,
    crossCheck: (args) => {
      const [num, den] = args as [bigint, bigint];
      if (num <= den) return [];
      return [
        {
          field: "num",
          message: `The numerator must not exceed the denominator - ${num}/${den} would pay out more than the odds, which is a negative house edge`,
        },
      ];
    },
    describe: (args) => {
      const [num, den] = args as [bigint, bigint];
      return `payout ${num}/${den} × odds - a ${edgePercentLabel(num, den)} house edge`;
    },
  },
  {
    id: "setSolvencyCap",
    label: "Solvency cap",
    summary: "A single win may pay at most 1/den of the treasury. A larger den is safer.",
    fields: [
      {
        name: "den",
        label: "Cap denominator",
        kind: "integer",
        min: 1n,
        max: MAX_ECONOMIC_RATIO,
        maxReason: "the game packs it into 56 bits and reverts above that",
        placeholder: "100",
        hint: "100 = the 1% cap that makes the house solvent by construction.",
      },
    ],
    needsEconomicsUnlocked: true,
    needsIdleGame: true,
    describe: (args) => `a single win pays at most 1/${args[0] as bigint} of the treasury`,
  },
  {
    id: "setTreasuryFloor",
    label: "Treasury floor",
    summary: "Below this balance the game stops accepting bets. The reserve the cap depends on.",
    fields: [
      {
        name: "newFloor",
        label: "Treasury floor (RUSH)",
        kind: "rush",
        min: 1n,
        placeholder: "95000",
      },
    ],
    needsEconomicsUnlocked: true,
    needsIdleGame: true,
    describe: (args) => `treasury floor → ${formatRush(args[0] as bigint)} RUSH`,
  },
  {
    id: "burnTreasuryProfit",
    label: "Burn treasury profit",
    summary:
      "Permanently destroy RUSH held above the floor - the deflation policy, executed by hand.",
    fields: [
      {
        name: "amount",
        label: "Amount to burn (RUSH)",
        kind: "rush",
        min: 1n,
        placeholder: "1000",
        hint: "Only the balance above the treasury floor is discretionary profit.",
      },
    ],
    needsEconomicsUnlocked: false,
    needsIdleGame: true,
    describe: (args) => `burn ${formatRush(args[0] as bigint)} RUSH of treasury profit`,
    preflight: (args, state) => {
      const headroom =
        state.treasuryBalance > state.treasuryFloor
          ? state.treasuryBalance - state.treasuryFloor
          : 0n;
      if ((args[0] as bigint) <= headroom) return [];
      return [
        {
          code: "burn-exceeds-headroom",
          message: `Burning ${formatRush(args[0] as bigint)} RUSH exceeds the ${formatRush(headroom)} RUSH of profit currently above the treasury floor. The floor is the solvency reserve and cannot be burned, so this reverts unless the treasury has grown by execution time.`,
        },
      ];
    },
  },
] as const;

const BY_ID = new Map(ADMIN_OPS.map((op) => [op.id, op]));

/** Look up an operation's spec. Throws on an id outside the catalogue. */
export function adminOp(id: AdminOpId): AdminOpSpec {
  const op = BY_ID.get(id);
  if (!op) throw new Error(`unknown admin operation "${id}"`);
  return op;
}

const WHOLE_NUMBER = /^\d+$/;
const DECIMAL_AMOUNT = /^\d+(\.\d{1,18})?$/;

/**
 * Parse a form's raw strings into contract arguments, collecting every problem rather
 * than stopping at the first - an operator fixing a form wants all of it flagged at once.
 */
export function parseAdminOp(
  id: AdminOpId,
  raw: Record<string, string | undefined>,
  options: ParseOptions = {},
): OpParseResult {
  const spec = adminOp(id);
  const errors: OpFieldError[] = [];
  const args: unknown[] = [];
  let complete = true;

  for (const field of spec.fields) {
    const value = parseField(field, raw[field.name], errors);
    if (value === undefined) complete = false;
    else args.push(value);
  }

  // Cross-field rules only make sense once every field parsed; running them on a
  // partial set would report a second, confusing error for the same mistake.
  if (complete && spec.crossCheck) errors.push(...spec.crossCheck(args, options));

  if (errors.length > 0 || !complete) return { ok: false, errors };
  return { ok: true, args };
}

function parseField(
  field: AdminOpField,
  raw: string | undefined,
  errors: OpFieldError[],
): bigint | boolean | undefined {
  const value = raw?.trim() ?? "";
  if (value === "") {
    errors.push({ field: field.name, message: `${field.label} is required` });
    return undefined;
  }

  if (field.kind === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    errors.push({ field: field.name, message: `${field.label} must be true or false` });
    return undefined;
  }

  if (field.kind === "integer") {
    // Deliberately stricter than BigInt(): "12.5" and "1e18" would throw, but "-5" and
    // "0x..." would not, and neither is what an operator meant to type in a bps box.
    if (!WHOLE_NUMBER.test(value)) {
      errors.push({ field: field.name, message: `${field.label} must be a whole number` });
      return undefined;
    }
    return withinBound(field, BigInt(value), errors);
  }

  if (!DECIMAL_AMOUNT.test(value)) {
    errors.push({
      field: field.name,
      message: `${field.label} must be a RUSH amount, e.g. 1000 or 2.5 (up to 18 decimals)`,
    });
    return undefined;
  }
  return withinBound(field, parseRush(value), errors);
}

function withinBound(
  field: AdminOpField,
  value: bigint,
  errors: OpFieldError[],
): bigint | undefined {
  if (field.min !== undefined && value < field.min) {
    errors.push({
      field: field.name,
      message:
        field.kind === "rush"
          ? `${field.label} must be greater than zero - the game rejects it otherwise`
          : `${field.label} must be at least ${field.min}`,
    });
    return undefined;
  }
  if (field.max !== undefined && value > field.max) {
    errors.push({
      field: field.name,
      message:
        `${field.label} must be at most ${field.max}` +
        (field.maxReason ? ` - ${field.maxReason}` : ""),
    });
    return undefined;
  }
  return value;
}

/** Encode a parsed operation as calldata against the game. */
export function encodeAdminOp(id: AdminOpId, args: readonly unknown[]): Hex {
  return encodeFunctionData({
    abi: GAME_ABI,
    functionName: id,
    // The args were produced by `parseAdminOp` from this same catalogue, whose field
    // list mirrors the ABI; viem re-checks them against the ABI as it encodes.
    args: args as never,
  });
}

export interface AdminCallDescription {
  id: AdminOpId;
  label: string;
  /** What the call does, with its arguments rendered in human units. */
  detail: string;
}

/**
 * Read calldata back into plain language.
 *
 * The pending queue is rebuilt from the timelock's `CallScheduled` logs, so what an
 * operator is asked to approve has to be recovered from the calldata itself - not
 * remembered from the form that produced it, which may have been a different browser,
 * a different operator, or two days ago.
 *
 * Returns null for anything this catalogue did not build, so a call queued elsewhere
 * is shown as unrecognised rather than mislabelled as something familiar.
 */
export function describeAdminCall(data: Hex): AdminCallDescription | null {
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: GAME_ABI, data });
  } catch {
    return null;
  }
  const spec = BY_ID.get(decoded.functionName as AdminOpId);
  if (!spec) return null;
  return { id: spec.id, label: spec.label, detail: spec.describe(decoded.args ?? []) };
}

/**
 * What is true right now that would make this call revert.
 *
 * These warn rather than block: an operation queued today executes after the timelock
 * delay, by which time the economy may have been unlocked (usually by a change queued
 * alongside this one), the bet settled, and the treasury grown. Every one of them is
 * re-checked by the contract at execution.
 */
export function preflightAdminOp(
  id: AdminOpId,
  args: readonly unknown[],
  state: AdminGameState,
): AdminWarning[] {
  const spec = adminOp(id);
  const warnings: AdminWarning[] = [];

  if (spec.needsEconomicsUnlocked && !state.economicsGovernable) {
    warnings.push({
      code: "economics-locked",
      message:
        "The economic setters are locked. This reverts unless setEconomicsGovernable(true) has executed first - queue that change alongside this one.",
    });
  }

  if (spec.needsIdleGame && state.activeBetId !== 0n) {
    warnings.push({
      code: "bet-in-flight",
      message: `A bet is in flight (bet #${state.activeBetId}). This reverts unless it has settled or been refunded by execution time.`,
    });
  }

  if (spec.preflight) warnings.push(...spec.preflight(args, state));

  return warnings;
}
