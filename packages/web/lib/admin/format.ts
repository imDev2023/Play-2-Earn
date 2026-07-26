import { formatUnits, parseUnits } from "viem";

/**
 * Formatting and parsing for the console's units.
 *
 * Everything the operator reads or types arrives in a machine unit — seconds, wei,
 * basis points — and each is the wrong unit for the decision being made with it. These
 * are the single conversion point, so the form, the treasury readout and the queue all
 * quote a value the same way.
 */

/** RUSH has 18 decimals. Operators type token amounts; the chain wants wei. */
export const RUSH_DECIMALS = 18;

/** Basis-points denominator, mirroring `RushoodGame.BPS_DEN`. */
const BPS_DEN = 10_000n;

const UNITS: readonly [suffix: string, seconds: bigint][] = [
  ["d", 86_400n],
  ["h", 3_600n],
  ["m", 60n],
  ["s", 1n],
];

/**
 * A duration in seconds, as the two most significant units: `183600n` → `"2d 3h"`.
 * Anything at or below zero has already elapsed.
 */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return "immediately";

  const parts: string[] = [];
  let remaining = seconds;
  for (const [suffix, size] of UNITS) {
    const count = remaining / size;
    if (count > 0n) {
      parts.push(`${count}${suffix}`);
      remaining -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** An address abbreviated for a table, keeping both ends so it stays checkable. */
export function shortAddress(address?: string): string {
  if (!address) return "—";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A RUSH amount as a token amount, trailing zeros trimmed by viem. */
export function formatRush(wei: bigint): string {
  return formatUnits(wei, RUSH_DECIMALS);
}

/** A decimal RUSH amount as wei. */
export function parseRush(amount: string): bigint {
  return parseUnits(amount, RUSH_DECIMALS);
}

/** Basis points as a percentage label: `250n` → `"2.5%"`. */
export function percentLabel(bps: bigint): string {
  return `${Number(bps) / 100}%`;
}

/**
 * The house edge implied by a payout fraction: `95/100` → `"5%"`.
 * Computed in integer arithmetic so the label never renders as 4.999999999999996%.
 */
export function edgePercentLabel(num: bigint, den: bigint): string {
  if (den === 0n) return "—";
  return `${Number(((den - num) * BPS_DEN) / den) / 100}%`;
}
