import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { betBoundsLabel, formatAmount } from "../lib/amount";

/**
 * Displaying an amount a player is meant to act on.
 *
 * The case that drove this: the bet ceiling is `solvencyCap / odds`, a division that
 * almost never terminates, so a treasury supporting 10,000 RUSH at coin-flip odds was
 * offered to players as `max 5263.157894736842105263`.
 *
 * The direction of rounding is the part with teeth. A ceiling rounded to nearest can
 * round up, and then the number on screen is one the contract rejects.
 */

const RUSH = (n: bigint) => n * 10n ** 18n;

describe("formatAmount", () => {
  it("groups thousands", () => {
    assert.equal(formatAmount(RUSH(1_234_567n)), "1,234,567");
  });

  it("keeps a whole number whole rather than padding it with zeros", () => {
    assert.equal(formatAmount(RUSH(1n)), "1");
  });

  it("keeps an exact fraction exactly, in either direction", () => {
    const exact = RUSH(5257n) + RUSH(1n) / 2n; // 5257.5
    assert.equal(formatAmount(exact, { rounding: "down" }), "5,257.5");
    assert.equal(formatAmount(exact, { rounding: "up" }), "5,257.5");
  });

  it("drops a trailing zero, so 1.50 reads as 1.5", () => {
    assert.equal(formatAmount(RUSH(3n) / 2n), "1.5");
  });

  it("truncates the repeating ceiling rather than showing 21 significant figures", () => {
    // 10000 / 1.9, the value the bug report quoted.
    const max = (RUSH(10_000n) * 10n) / 19n;
    assert.equal(formatAmount(max, { rounding: "down" }), "5,263.15");
  });

  it("rounds a maximum DOWN, so the displayed value is one the contract accepts", () => {
    const max = (RUSH(10_000n) * 10n) / 19n; // 5263.157894...
    const shown = formatAmount(max, { rounding: "down" });
    assert.equal(shown, "5,263.15");
    // The point of the direction: parsing what we showed stays inside the bound.
    const reparsed = 526315n * 10n ** 16n;
    assert.ok(reparsed <= max, "a displayed maximum must not exceed the real maximum");
  });

  it("rounds a minimum UP, so the displayed value clears the bound", () => {
    const min = RUSH(1n) + 1n; // barely over 1
    const shown = formatAmount(min, { rounding: "up" });
    assert.equal(shown, "1.01");
    const reparsed = 101n * 10n ** 16n;
    assert.ok(reparsed >= min, "a displayed minimum must not fall below the real minimum");
  });

  it("handles zero", () => {
    assert.equal(formatAmount(0n), "0");
  });
});

describe("betBoundsLabel", () => {
  it("phrases the range in words rather than as two raw numbers", () => {
    const min = RUSH(1n);
    const max = (RUSH(10_000n) * 10n) / 19n;
    assert.equal(betBoundsLabel(min, max), "1 to 5,263.15 RUSH");
  });
});
