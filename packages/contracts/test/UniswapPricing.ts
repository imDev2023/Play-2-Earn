import { expect } from "chai";
import {
  DEFAULT_FEE_TIER,
  MAX_TICK,
  MIN_TICK,
  TICK_SPACINGS,
  buildSeedParams,
  encodeSqrtPriceX96,
  fullRangeTicks,
  orderTokens,
  sqrtBigInt,
} from "../scripts/lib/uniswap-price";

/**
 * Uniswap seeding maths (#26).
 *
 * The launch pool is seeded once, with 250,000,000 RUSH against 25 ETH - a price of
 * 1e-7 ETH per RUSH. If the price is encoded inverted, or the token ordering is wrong,
 * the pool opens at ~1e14× the intended rate and the first swap empties it. There is no
 * second attempt and no way to unwind it, so the arithmetic is pinned down here.
 */

const RUSH_SEED = 250_000_000n * 10n ** 18n; // 25% of supply
const ETH_SEED = 25n * 10n ** 18n; // 25 ETH
const Q96 = 2n ** 96n;

// Two addresses chosen so their ordering is unambiguous and can be flipped in tests.
const LOW_ADDRESS = "0x1111111111111111111111111111111111111111";
const HIGH_ADDRESS = "0xdddddddddddddddddddddddddddddddddddddddd";

/** Recover price (token1 per token0), scaled by 1e18 so it can be asserted as an integer. */
function decodePriceScaled(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96);
}

/**
 * sqrtPriceX96 is an integer, so encoding a price floors it and squaring propagates
 * that truncation - a round-trip lands within a hair of the input rather than exactly
 * on it. What matters is that the error is negligible, so assert the bound (1 part in
 * 1e9) instead of pretending the arithmetic is exact. At the launch price that is a
 * deviation of well under a wei of ETH per RUSH.
 */
const PRECISION_BOUND = 10n ** 9n;

function expectPriceWithinTolerance(actual: bigint, expected: bigint): void {
  const difference = actual > expected ? actual - expected : expected - actual;
  expect(
    difference * PRECISION_BOUND <= expected,
    `expected ${actual} to be within 1/1e9 of ${expected}`,
  ).to.equal(true);
}

describe("Uniswap seeding maths (#26)", () => {
  describe("integer square root", () => {
    it("is exact for perfect squares", () => {
      for (const root of [0n, 1n, 2n, 7n, 1_000n, 2n ** 48n]) {
        expect(sqrtBigInt(root * root)).to.equal(root);
      }
    });

    it("floors non-perfect squares", () => {
      expect(sqrtBigInt(8n)).to.equal(2n);
      expect(sqrtBigInt(99n)).to.equal(9n);
    });

    it("handles values far beyond 2^64", () => {
      const big = 10n ** 40n;
      const root = sqrtBigInt(big);
      expect(root * root).to.be.lessThanOrEqual(big);
      expect((root + 1n) * (root + 1n)).to.be.greaterThan(big);
    });

    it("rejects negative input", () => {
      expect(() => sqrtBigInt(-1n)).to.throw(/negative/);
    });
  });

  describe("token ordering", () => {
    it("puts the lower address first regardless of argument order", () => {
      const forward = orderTokens(LOW_ADDRESS, HIGH_ADDRESS);
      const reversed = orderTokens(HIGH_ADDRESS, LOW_ADDRESS);

      expect(forward.token0).to.equal(LOW_ADDRESS);
      expect(reversed.token0).to.equal(LOW_ADDRESS);
      expect(forward.token1).to.equal(HIGH_ADDRESS);
      expect(reversed.token1).to.equal(HIGH_ADDRESS);
    });

    it("reports whether the first argument became token0", () => {
      expect(orderTokens(LOW_ADDRESS, HIGH_ADDRESS).aIsToken0).to.equal(true);
      expect(orderTokens(HIGH_ADDRESS, LOW_ADDRESS).aIsToken0).to.equal(false);
    });

    it("compares case-insensitively, as address checksums vary", () => {
      const mixed = orderTokens(LOW_ADDRESS.toUpperCase().replace("0X", "0x"), HIGH_ADDRESS);
      expect(mixed.aIsToken0).to.equal(true);
    });
  });

  describe("price encoding", () => {
    it("encodes a 1:1 pool as exactly 2^96", () => {
      expect(encodeSqrtPriceX96(10n ** 18n, 10n ** 18n)).to.equal(Q96);
    });

    it("encodes a 4:1 pool as 2 * 2^96", () => {
      expect(encodeSqrtPriceX96(10n ** 18n, 4n * 10n ** 18n)).to.equal(2n * Q96);
    });

    it("round-trips the launch price of 1e-7 ETH per RUSH", () => {
      const sqrtPriceX96 = encodeSqrtPriceX96(RUSH_SEED, ETH_SEED);
      // 1e-7 scaled by 1e18 is 1e11.
      expectPriceWithinTolerance(decodePriceScaled(sqrtPriceX96), 10n ** 11n);
    });

    it("encodes the inverse when the amounts are swapped", () => {
      const sqrtPriceX96 = encodeSqrtPriceX96(ETH_SEED, RUSH_SEED);
      // 1e7 scaled by 1e18.
      expectPriceWithinTolerance(decodePriceScaled(sqrtPriceX96), 10n ** 25n);
    });

    it("rejects a zero seed amount on either side", () => {
      expect(() => encodeSqrtPriceX96(0n, ETH_SEED)).to.throw(/positive/);
      expect(() => encodeSqrtPriceX96(RUSH_SEED, 0n)).to.throw(/positive/);
    });
  });

  describe("full-range ticks", () => {
    it("lands on multiples of the fee tier's spacing", () => {
      for (const [fee, spacing] of Object.entries(TICK_SPACINGS)) {
        const { tickLower, tickUpper } = fullRangeTicks(Number(fee));
        expect(tickLower % spacing).to.equal(0);
        expect(tickUpper % spacing).to.equal(0);
      }
    });

    it("stays inside Uniswap's absolute bounds", () => {
      const { tickLower, tickUpper } = fullRangeTicks(DEFAULT_FEE_TIER);
      expect(tickLower).to.be.greaterThanOrEqual(MIN_TICK);
      expect(tickUpper).to.be.lessThanOrEqual(MAX_TICK);
      expect(tickLower).to.be.lessThan(tickUpper);
    });

    it("is symmetric about zero", () => {
      const { tickLower, tickUpper } = fullRangeTicks(DEFAULT_FEE_TIER);
      expect(tickLower).to.equal(-tickUpper);
    });

    it("rejects a fee tier the factory doesn't have", () => {
      expect(() => fullRangeTicks(1_234)).to.throw(/unknown fee tier/);
    });
  });

  describe("seed params", () => {
    it("keeps each token paired with its own amount when RUSH sorts first", () => {
      const params = buildSeedParams({
        tokenA: LOW_ADDRESS,
        amountA: RUSH_SEED,
        tokenB: HIGH_ADDRESS,
        amountB: ETH_SEED,
      });

      expect(params.token0).to.equal(LOW_ADDRESS);
      expect(params.amount0).to.equal(RUSH_SEED);
      expect(params.amount1).to.equal(ETH_SEED);
    });

    it("keeps each token paired with its own amount when RUSH sorts second", () => {
      const params = buildSeedParams({
        tokenA: HIGH_ADDRESS,
        amountA: RUSH_SEED,
        tokenB: LOW_ADDRESS,
        amountB: ETH_SEED,
      });

      expect(params.token0).to.equal(LOW_ADDRESS);
      expect(params.amount0).to.equal(ETH_SEED);
      expect(params.amount1).to.equal(RUSH_SEED);
    });

    it("encodes a price consistent with whichever ordering it produced", () => {
      // The pool price is always token1-per-token0. Whichever way the addresses sort,
      // the encoded price must describe the amounts actually being deposited - this is
      // the assertion that would fail if ordering and amounts ever came apart.
      for (const [tokenA, tokenB] of [
        [LOW_ADDRESS, HIGH_ADDRESS],
        [HIGH_ADDRESS, LOW_ADDRESS],
      ]) {
        const params = buildSeedParams({
          tokenA,
          amountA: RUSH_SEED,
          tokenB,
          amountB: ETH_SEED,
        });
        expectPriceWithinTolerance(
          decodePriceScaled(params.sqrtPriceX96),
          (params.amount1 * 10n ** 18n) / params.amount0,
        );
      }
    });

    it("defaults to the 0.30% tier at full range", () => {
      const params = buildSeedParams({
        tokenA: LOW_ADDRESS,
        amountA: RUSH_SEED,
        tokenB: HIGH_ADDRESS,
        amountB: ETH_SEED,
      });

      expect(params.fee).to.equal(DEFAULT_FEE_TIER);
      expect(params.tickLower).to.equal(fullRangeTicks(DEFAULT_FEE_TIER).tickLower);
      expect(params.tickUpper).to.equal(fullRangeTicks(DEFAULT_FEE_TIER).tickUpper);
    });

    it("honours an explicit fee tier", () => {
      const params = buildSeedParams({
        tokenA: LOW_ADDRESS,
        amountA: RUSH_SEED,
        tokenB: HIGH_ADDRESS,
        amountB: ETH_SEED,
        feeTier: 10_000,
      });

      expect(params.fee).to.equal(10_000);
      expect(params.tickUpper % TICK_SPACINGS[10_000]).to.equal(0);
    });
  });
});
