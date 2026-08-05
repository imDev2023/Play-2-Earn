/**
 * Turning wei into something a person can read, without lying about the bound.
 *
 * `formatUnits` is exact and unbounded, which is right for a value the player must be
 * able to reproduce and wrong for a value they are meant to act on. The bet ceiling is
 * `solvencyCap / odds`, and that division almost never terminates: a treasury that
 * happens to support 10,000 RUSH at coin-flip odds renders as
 * `5263.157894736842105263`. Twenty-one significant figures, offered as advice.
 *
 * The subtlety is the direction. A ceiling rounded to the nearest value can round *up*,
 * and a player who then types the number they were shown has their bet rejected by the
 * contract for exceeding the maximum it just told them about. So bounds round away from
 * the range they open: a maximum rounds down, a minimum rounds up. Whatever is
 * displayed is always a value that is actually accepted.
 */

/** Which way to break a value that does not land exactly on the displayed precision. */
export type Rounding = "down" | "up";

/** Digits after the decimal point on a displayed amount. */
const DISPLAY_DECIMALS = 2;

/** RUSH is an 18-decimal token, and it is the only thing this app displays. */
const WEI_PER_RUSH = 10n ** 18n;

/**
 * Format a RUSH amount for display, rounding in the direction that keeps it valid.
 *
 * Exact values print exactly: a maximum that really is 5257.5 keeps its half, and a
 * minimum of 1 stays `1` rather than becoming `1.00`. Only a value that needs more
 * precision than we show gets rounded, which is the case the direction matters for.
 *
 * Amounts here are balances, stakes and payouts, so they are never negative.
 */
export function formatAmount(
  wei: bigint,
  { rounding = "down" }: { rounding?: Rounding } = {},
): string {
  const scale = WEI_PER_RUSH;
  const shown = 10n ** BigInt(DISPLAY_DECIMALS);
  // Value expressed in units of the smallest digit we display.
  const units = (wei * shown) / scale;
  const exact = units * scale === wei * shown;

  const rounded = exact || rounding === "down" ? units : units + 1n;

  const whole = rounded / shown;
  const fraction = rounded % shown;

  const group = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fraction === 0n) return group;

  // Trailing zeros carry no information here: 1.50 is 1.5.
  const digits = fraction.toString().padStart(DISPLAY_DECIMALS, "0").replace(/0+$/, "");
  return `${group}.${digits}`;
}

/**
 * The stake range, phrased as a range rather than as two raw numbers.
 *
 * Both ends round outward-safe, so a player who types either bound is inside it.
 */
export function betBoundsLabel(minBet: bigint, maxBet: bigint): string {
  const min = formatAmount(minBet, { rounding: "up" });
  const max = formatAmount(maxBet, { rounding: "down" });
  return `${min} to ${max} RUSH`;
}
