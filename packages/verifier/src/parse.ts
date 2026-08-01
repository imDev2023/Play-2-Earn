/**
 * Parsing and validation for verifier inputs supplied as text.
 *
 * The `/verify` page (form fields and URL query params) and the CLI both receive
 * strings, and both need the same answer to "is this a usable bet record?". Keeping
 * that in one place means a link that verifies in the browser verifies identically
 * on the command line.
 */

import type { VerifyInputs } from "./index";
import { TIER_ODDS } from "./index";

/** The verifier inputs as they arrive from a form, a URL, or argv. */
export interface RawVerifyInputs {
  betId?: string | null;
  tier?: string | null;
  clientEntropy?: string | null;
  serverReveal?: string | null;
  commitment?: string | null;
  /** Optional cross-checks: what the chain claims happened. */
  win?: string | null;
  roll?: string | null;
}

/** Which input a problem belongs to, so a form can render it inline. */
export type VerifyField = keyof RawVerifyInputs;

export interface FieldError {
  field: VerifyField;
  message: string;
}

export type ParseResult =
  | { ok: true; inputs: VerifyInputs }
  | { ok: false; errors: FieldError[] };

/**
 * The inverse of `parseVerifyInputs`: render inputs as URL query params.
 *
 * This is what makes a "one-click verify link" honest - the link carries every input,
 * so whoever opens it verifies from the link itself rather than from a lookup they'd
 * have to trust. Because both directions live here, a link built by the app is
 * guaranteed to parse in the app, in the CLI, and anywhere else this module runs.
 */
export function verifyQueryParams(inputs: VerifyInputs): URLSearchParams {
  const params = new URLSearchParams({
    betId: inputs.betId.toString(),
    tier: String(inputs.tier),
    clientEntropy: inputs.clientEntropy.toString(),
    commitment: inputs.commitment,
    serverReveal: inputs.serverReveal,
  });
  if (inputs.reported?.win !== undefined) params.set("win", String(inputs.reported.win));
  if (inputs.reported?.roll !== undefined) params.set("roll", inputs.reported.roll.toString());
  return params;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse raw text into `VerifyInputs`, collecting *every* problem rather than
 * stopping at the first - a player pasting a record wants all of it flagged at once.
 */
export function parseVerifyInputs(raw: RawVerifyInputs): ParseResult {
  const errors: FieldError[] = [];

  const betId = parseUint(raw.betId, "betId", errors, { min: 1n });
  const tier = parseTier(raw.tier, errors);
  const clientEntropy = parseUint(raw.clientEntropy, "clientEntropy", errors);
  const serverReveal = parseBytes32(raw.serverReveal, "serverReveal", errors);
  const commitment = parseBytes32(raw.commitment, "commitment", errors);

  const reported: { win?: boolean; roll?: bigint } = {};
  const win = parseBool(raw.win, errors);
  if (win !== undefined) reported.win = win;
  if (isPresent(raw.roll)) {
    const roll = parseUint(raw.roll, "roll", errors);
    if (roll !== undefined) reported.roll = roll;
  }

  if (
    errors.length > 0 ||
    betId === undefined ||
    tier === undefined ||
    clientEntropy === undefined ||
    serverReveal === undefined ||
    commitment === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    inputs: {
      betId,
      tier,
      clientEntropy,
      serverReveal,
      commitment,
      ...(Object.keys(reported).length > 0 ? { reported } : {}),
    },
  };
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseUint(
  value: string | null | undefined,
  field: VerifyField,
  errors: FieldError[],
  opts: { min?: bigint } = {},
): bigint | undefined {
  if (!isPresent(value)) {
    errors.push({ field, message: `${field} is required` });
    return undefined;
  }
  let parsed: bigint;
  try {
    // BigInt() accepts 0x-prefixed hex as well as decimal, so a record copied from
    // an explorer works either way.
    parsed = BigInt(value.trim());
  } catch {
    errors.push({ field, message: `${field} must be a whole number (decimal or 0x hex)` });
    return undefined;
  }
  const min = opts.min ?? 0n;
  if (parsed < min) {
    errors.push({ field, message: `${field} must be at least ${min}` });
    return undefined;
  }
  return parsed;
}

function parseTier(value: string | null | undefined, errors: FieldError[]): number | undefined {
  if (!isPresent(value)) {
    errors.push({ field: "tier", message: "tier is required" });
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= TIER_ODDS.length) {
    errors.push({
      field: "tier",
      message: `tier must be 0-${TIER_ODDS.length - 1} (the published odds ladder)`,
    });
    return undefined;
  }
  return parsed;
}

function parseBytes32(
  value: string | null | undefined,
  field: VerifyField,
  errors: FieldError[],
): `0x${string}` | undefined {
  if (!isPresent(value)) {
    errors.push({ field, message: `${field} is required` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!BYTES32.test(trimmed)) {
    errors.push({ field, message: `${field} must be a 32-byte hex value (0x + 64 hex digits)` });
    return undefined;
  }
  return trimmed.toLowerCase() as `0x${string}`;
}

function parseBool(value: string | null | undefined, errors: FieldError[]): boolean | undefined {
  if (!isPresent(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  errors.push({ field: "win", message: "win must be true or false" });
  return undefined;
}
