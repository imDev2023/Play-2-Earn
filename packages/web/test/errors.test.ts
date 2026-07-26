import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readableError } from "../lib/errors";

describe("readableError", () => {
  it("keeps only the first line of a multi-paragraph provider error", () => {
    const error = new Error(
      "The contract function \"setMinBet\" reverted.\n\nError: EconomicsLocked()\n\nVersion: viem@2.55.2",
    );
    assert.equal(readableError(error), 'The contract function "setMinBet" reverted.');
  });

  it("handles a thrown non-Error", () => {
    assert.equal(readableError("user rejected"), "user rejected");
  });
});
