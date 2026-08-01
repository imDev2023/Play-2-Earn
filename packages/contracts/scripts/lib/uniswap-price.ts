/**
 * Uniswap v3 pricing helpers for the launch pool (#26).
 *
 * Seeding a v3 pool means choosing three things: which token is `token0`, the initial
 * `sqrtPriceX96`, and the tick range the liquidity sits in. All three are easy to get
 * quietly wrong - an inverted price seeds the pool at 1e14× the intended rate and the
 * first swap drains it - so the arithmetic lives here, in a module with unit tests,
 * rather than inline in a deploy script that only ever runs once.
 *
 * Everything is integer maths on bigints. Floating point is deliberately avoided:
 * a rounding error here is a real, unrecoverable loss of the LP allocation.
 */

/** Uniswap v3's absolute tick bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** Tick spacing per fee tier, as configured in the v3 factory. */
export const TICK_SPACINGS: Readonly<Record<number, number>> = {
  100: 1,
  500: 10,
  3_000: 60,
  10_000: 200,
};

/**
 * Fee tier for the RUSH pool, in hundredths of a bip (3000 = 0.30%).
 *
 * 0.30% is the standard tier for a volatile pair and the one routers and aggregators
 * quote against by default. The 1% tier would earn more per swap but fragments
 * liquidity and is less likely to be routed through.
 */
export const DEFAULT_FEE_TIER = 3_000;

/** Uniswap orders a pool's tokens by address; the lower address is always token0. */
export function orderTokens(
  tokenA: string,
  tokenB: string,
): { token0: string; token1: string; aIsToken0: boolean } {
  const aIsToken0 = tokenA.toLowerCase() < tokenB.toLowerCase();
  return aIsToken0
    ? { token0: tokenA, token1: tokenB, aIsToken0 }
    : { token0: tokenB, token1: tokenA, aIsToken0 };
}

/** Integer square root (Newton's method), exact for perfect squares and floored otherwise. */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrtBigInt: negative input");
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * The pool's initial `sqrtPriceX96` for a starting reserve ratio.
 *
 * A v3 pool's price is always expressed as token1 per token0, encoded as
 * `sqrt(price) * 2^96`. Passing the two seed amounts (rather than a decimal price)
 * keeps the caller honest: the ratio that gets encoded is exactly the ratio of tokens
 * actually being deposited.
 *
 * @param amount0 Seed amount of token0, in its own smallest unit.
 * @param amount1 Seed amount of token1, in its own smallest unit.
 */
export function encodeSqrtPriceX96(amount0: bigint, amount1: bigint): bigint {
  if (amount0 <= 0n || amount1 <= 0n) {
    throw new Error("encodeSqrtPriceX96: both seed amounts must be positive");
  }
  // sqrt(amount1 / amount0) * 2^96, computed as sqrt(amount1 * 2^192 / amount0) so the
  // shift happens before the division and no precision is lost to integer truncation.
  return sqrtBigInt((amount1 << 192n) / amount0);
}

/**
 * The widest tick range a fee tier allows - liquidity across the entire price curve.
 *
 * Full range is the right shape for a launch pool: the price has no history to
 * concentrate around, and a range order that the price walks out of would leave the
 * pool one-sided and effectively dead. It also means the locked position keeps earning
 * fees no matter where the price goes during the 2-year lock.
 */
export function fullRangeTicks(feeTier: number = DEFAULT_FEE_TIER): {
  tickLower: number;
  tickUpper: number;
} {
  const spacing = TICK_SPACINGS[feeTier];
  if (spacing === undefined) throw new Error(`fullRangeTicks: unknown fee tier ${feeTier}`);

  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  };
}

/** What the caller wants to seed, in their own terms - "this much RUSH against this much WETH". */
export interface SeedRequest {
  readonly tokenA: string;
  readonly amountA: bigint;
  readonly tokenB: string;
  readonly amountB: bigint;
  readonly feeTier?: number;
}

/** Everything `createAndInitializePoolIfNecessary` + `mint` need, in Uniswap's terms. */
export interface SeedParams {
  readonly token0: string;
  readonly token1: string;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly fee: number;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
}

/**
 * Translate a human seed intent into Uniswap's token0/token1 world.
 *
 * This exists to kill one specific bug: Uniswap orders a pool's tokens by address, and
 * whether RUSH lands as token0 or token1 depends on an address that isn't known until
 * deploy time. Getting that backwards inverts the price by ~1e14 and the first swap
 * takes the entire LP allocation. Callers state their intent in their own terms and
 * this function does the ordering, so no deploy script has to reason about it.
 */
export function buildSeedParams(request: SeedRequest): SeedParams {
  const fee = request.feeTier ?? DEFAULT_FEE_TIER;
  const { token0, token1, aIsToken0 } = orderTokens(request.tokenA, request.tokenB);

  const amount0 = aIsToken0 ? request.amountA : request.amountB;
  const amount1 = aIsToken0 ? request.amountB : request.amountA;

  return {
    token0,
    token1,
    amount0,
    amount1,
    fee,
    sqrtPriceX96: encodeSqrtPriceX96(amount0, amount1),
    ...fullRangeTicks(fee),
  };
}
