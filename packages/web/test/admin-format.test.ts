import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatDuration, shortAddress } from "../lib/admin/format";

/**
 * Timelock delays are quoted in seconds on-chain and read as nonsense there — "172800"
 * tells an operator nothing about whether a change lands tomorrow or next week.
 */

describe("formatDuration", () => {
  it("renders a zero delay as immediate", () => {
    assert.equal(formatDuration(0n), "immediately");
  });

  it("keeps short delays in seconds", () => {
    assert.equal(formatDuration(45n), "45s");
  });

  it("renders minutes, with the leftover seconds", () => {
    assert.equal(formatDuration(60n), "1m");
    assert.equal(formatDuration(330n), "5m 30s");
  });

  it("renders hours and days, to two units", () => {
    assert.equal(formatDuration(7200n), "2h");
    assert.equal(formatDuration(7500n), "2h 5m");
    assert.equal(formatDuration(172_800n), "2d");
    assert.equal(formatDuration(183_600n), "2d 3h");
  });

  it("treats a negative remaining time as elapsed", () => {
    assert.equal(formatDuration(-5n), "immediately");
  });
});

describe("shortAddress", () => {
  it("abbreviates an address without losing either end", () => {
    assert.equal(shortAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"), "0x7099…79C8");
  });

  it("leaves something too short to abbreviate alone", () => {
    assert.equal(shortAddress("0x70"), "0x70");
  });

  it("renders a missing address as a dash", () => {
    assert.equal(shortAddress(undefined), "—");
  });
});
