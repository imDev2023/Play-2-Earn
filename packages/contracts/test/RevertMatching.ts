import { expect } from "chai";
import { Interface } from "ethers";
import { matchesCustomError, revertData, revertsWith } from "../scripts/lib/revert-matching";

/**
 * Matching a custom error across RPC providers (#26).
 *
 * The launch checklist's negative items — "a bet below minBet is rejected", "a non-owner
 * cannot withdraw" — only mean anything if they can tell *which* error came back. A
 * check that accepts any revert passes just as happily on a mistyped address.
 *
 * The catch is that providers disagree about how to report one. Hardhat's in-process node
 * hands ethers a decoded `revert` object; a public RPC node returns the raw ABI-encoded
 * error bytes and ethers leaves `revert` undefined. The original implementation only read
 * the decoded form, so every negative item failed against a real chain while passing
 * locally — which is why the local dry run went green and testnet did not.
 */

const IFACE = new Interface([
  "error OwnableUnauthorizedAccount(address account)",
  "error BetBelowMin(uint256 stake, uint256 minimum)",
  "error EnforcedPause()",
]);

/** What a public RPC node's revert looks like by the time ethers rethrows it. */
function rawDataError(data: string, message = "execution reverted"): unknown {
  return Object.assign(new Error(message), { code: 3, data });
}

/** What Hardhat's in-process node produces: already decoded. */
function decodedError(name: string): unknown {
  return Object.assign(new Error("reverted"), { revert: { name } });
}

describe("custom-error matching across providers (#26)", () => {
  describe("revertData", () => {
    it("reads data off the error itself", () => {
      const data = IFACE.encodeErrorResult("EnforcedPause", []);
      expect(revertData(rawDataError(data))).to.equal(data);
    });

    it("finds data nested under info.error, where some providers put it", () => {
      const data = IFACE.encodeErrorResult("EnforcedPause", []);
      const error = Object.assign(new Error("execution reverted"), {
        info: { error: { code: 3, data } },
      });
      expect(revertData(error)).to.equal(data);
    });

    it("ignores a bare 0x, which carries no error to match", () => {
      expect(revertData(rawDataError("0x"))).to.equal(undefined);
    });

    it("returns nothing when the error carries no revert data at all", () => {
      expect(revertData(new Error("connection reset"))).to.equal(undefined);
    });
  });

  describe("matchesCustomError", () => {
    it("matches raw ABI-encoded error bytes from a public node", () => {
      const data = IFACE.encodeErrorResult("OwnableUnauthorizedAccount", [
        "0x68793f133F7Bb955226fc43D9Dbc9B045C6f575D",
      ]);
      expect(matchesCustomError(rawDataError(data), "OwnableUnauthorizedAccount", IFACE)).to.equal(
        true,
      );
    });

    it("rejects raw bytes for a different error", () => {
      const data = IFACE.encodeErrorResult("EnforcedPause", []);
      expect(matchesCustomError(rawDataError(data), "OwnableUnauthorizedAccount", IFACE)).to.equal(
        false,
      );
    });

    it("still matches the decoded form Hardhat provides", () => {
      expect(matchesCustomError(decodedError("BetBelowMin"), "BetBelowMin", IFACE)).to.equal(true);
    });

    it("rejects a decoded error of the wrong name", () => {
      expect(matchesCustomError(decodedError("EnforcedPause"), "BetBelowMin", IFACE)).to.equal(
        false,
      );
    });

    /**
     * A selector the interface does not know is a revert from somewhere unexpected —
     * a different contract, or a proxy. Not a match, and not a crash either.
     */
    it("does not match an error the interface cannot decode", () => {
      expect(matchesCustomError(rawDataError("0xdeadbeef"), "BetBelowMin", IFACE)).to.equal(false);
    });

    it("falls back to the message when there is no data to decode", () => {
      const error = new Error("VM Exception: reverted with custom error 'BetBelowMin()'");
      expect(matchesCustomError(error, "BetBelowMin", IFACE)).to.equal(true);
    });
  });

  describe("revertsWith", () => {
    it("reports true when the expected error comes back as raw bytes", async () => {
      const data = IFACE.encodeErrorResult("EnforcedPause", []);
      const result = await revertsWith(
        () => Promise.reject(rawDataError(data)),
        "EnforcedPause",
        IFACE,
      );
      expect(result).to.equal(true);
    });

    /**
     * The failure that matters most: a call that was supposed to be refused but went
     * through. Treating that as a pass would turn the checklist into decoration.
     */
    it("reports false when the call does not revert at all", async () => {
      const result = await revertsWith(() => Promise.resolve("ok"), "EnforcedPause", IFACE);
      expect(result).to.equal(false);
    });

    it("reports false when a different error comes back", async () => {
      const data = IFACE.encodeErrorResult("BetBelowMin", [1n, 2n]);
      const result = await revertsWith(
        () => Promise.reject(rawDataError(data)),
        "EnforcedPause",
        IFACE,
      );
      expect(result).to.equal(false);
    });
  });
});
