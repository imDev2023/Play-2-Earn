import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commitmentFor, parseVerifyInputs, verifyQueryParams, verifyRoll } from "../src/index";

/**
 * The parser is the verifier's front door: every input arrives as text, from a form,
 * a URL, or argv. Its contract is that a well-formed record parses to exactly the
 * values a link carried, and a malformed one is rejected per field rather than
 * silently coerced into a verdict.
 */

const REVEAL = commitmentFor(`0x${"11".repeat(32)}`);
const COMMITMENT = commitmentFor(REVEAL);

const GOOD = {
  betId: "7",
  tier: "5",
  clientEntropy: "42",
  serverReveal: REVEAL,
  commitment: COMMITMENT,
};

function errorFields(raw: Parameters<typeof parseVerifyInputs>[0]): string[] {
  const result = parseVerifyInputs(raw);
  return result.ok ? [] : result.errors.map((e) => e.field);
}

describe("parseVerifyInputs", () => {
  it("parses a complete record", () => {
    const result = parseVerifyInputs(GOOD);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.inputs.betId, 7n);
    assert.equal(result.inputs.tier, 5);
    assert.equal(result.inputs.clientEntropy, 42n);
    assert.equal(result.inputs.serverReveal, REVEAL);
    assert.equal(result.inputs.reported, undefined);
  });

  it("accepts hex or decimal for the numeric fields, since explorers show both", () => {
    const hex = parseVerifyInputs({ ...GOOD, clientEntropy: "0x2a" });
    assert.equal(hex.ok, true);
    if (!hex.ok) return;
    assert.equal(hex.inputs.clientEntropy, 42n);
  });

  it("normalises hash casing, which chains and wallets disagree about", () => {
    const upper = parseVerifyInputs({ ...GOOD, serverReveal: REVEAL.toUpperCase().replace("0X", "0x") });
    assert.equal(upper.ok, true);
    if (!upper.ok) return;
    assert.equal(upper.inputs.serverReveal, REVEAL);
  });

  it("carries the chain's reported outcome through when supplied", () => {
    const result = parseVerifyInputs({ ...GOOD, win: "false", roll: "248" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.inputs.reported, { win: false, roll: 248n });
  });

  it("reports every missing field at once, not just the first", () => {
    assert.deepEqual(errorFields({}).sort(), [
      "betId",
      "clientEntropy",
      "commitment",
      "serverReveal",
      "tier",
    ]);
  });

  it("rejects a hash that isn't 32 bytes", () => {
    assert.deepEqual(errorFields({ ...GOOD, commitment: "0xdeadbeef" }), ["commitment"]);
    assert.deepEqual(errorFields({ ...GOOD, serverReveal: "not-a-hash" }), ["serverReveal"]);
  });

  it("rejects a tier outside the published ladder", () => {
    assert.deepEqual(errorFields({ ...GOOD, tier: "6" }), ["tier"]);
    assert.deepEqual(errorFields({ ...GOOD, tier: "-1" }), ["tier"]);
    assert.deepEqual(errorFields({ ...GOOD, tier: "1.5" }), ["tier"]);
  });

  it("rejects bet id 0 — ids start at 1, so 0 means 'no bet'", () => {
    assert.deepEqual(errorFields({ ...GOOD, betId: "0" }), ["betId"]);
  });

  it("rejects a non-numeric amount rather than coercing it", () => {
    assert.deepEqual(errorFields({ ...GOOD, clientEntropy: "twelve" }), ["clientEntropy"]);
  });

  it("rejects a win claim that is neither true nor false", () => {
    assert.deepEqual(errorFields({ ...GOOD, win: "maybe" }), ["win"]);
  });
});

describe("verifyQueryParams", () => {
  it("round-trips through a URL back into the same inputs", () => {
    const parsed = parseVerifyInputs({ ...GOOD, win: "false", roll: "248" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const url = new URL(`https://rushood.example/verify?${verifyQueryParams(parsed.inputs)}`);
    const reparsed = parseVerifyInputs(Object.fromEntries(url.searchParams));
    assert.equal(reparsed.ok, true);
    if (!reparsed.ok) return;
    assert.deepEqual(reparsed.inputs, parsed.inputs);
  });

  it("produces a link that verifies — the promise a share link makes", () => {
    const parsed = parseVerifyInputs(GOOD);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const reparsed = parseVerifyInputs(
      Object.fromEntries(verifyQueryParams(parsed.inputs)),
    );
    assert.equal(reparsed.ok, true);
    if (!reparsed.ok) return;
    assert.equal(verifyRoll(reparsed.inputs).commitmentValid, true);
  });
});
