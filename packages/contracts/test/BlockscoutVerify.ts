import { expect } from "chai";
import {
  buildVerifyForm,
  interpretPoll,
  interpretSubmit,
  verifyContract,
} from "../scripts/lib/blockscout-verify";

/**
 * Submitting source to Blockscout (#26).
 *
 * `hardhat-verify` cannot verify against the Robinhood Chain explorer: it sends the
 * constructor arguments as bare hex, and this Blockscout rejects anything without an
 * `0x` prefix - silently, as a plain "Fail - Unable to verify" after the submission has
 * already been accepted. Contracts with no constructor arguments verify fine through the
 * same path, which is what pins the cause to the arguments rather than the source.
 *
 * That single missing prefix is the whole reason the six launch contracts could not be
 * verified, so it is the thing these tests hold still.
 */

const REQUEST = {
  address: "0x0e589f857795257B0C288B2354cBF57F9D9276CD",
  contractName: "contracts/Rushood.sol:Rushood",
  compilerVersion: "v0.8.24+commit.e11b9ed9",
  standardInput: '{"language":"Solidity"}',
  optimizer: { enabled: true, runs: 200 },
};

describe("Blockscout verification (#26)", () => {
  describe("buildVerifyForm", () => {
    it("prefixes constructor arguments with 0x - the bug that blocked every launch contract", () => {
      const form = buildVerifyForm({ ...REQUEST, constructorArgs: "0000000000000000000000008ec5" });

      expect(form.get("constructorArguements")).to.equal("0x0000000000000000000000008ec5");
    });

    it("does not double-prefix arguments that already carry one", () => {
      const form = buildVerifyForm({ ...REQUEST, constructorArgs: "0xabcd" });

      expect(form.get("constructorArguements")).to.equal("0xabcd");
    });

    /**
     * A contract with no constructor arguments must not send an empty `0x`: that is what
     * "no arguments" looks like to us, but Blockscout reads it as a declared-empty tail
     * and matches differently.
     */
    it("omits the field entirely when there are no constructor arguments", () => {
      expect(buildVerifyForm({ ...REQUEST, constructorArgs: "0x" }).has("constructorArguements")).to
        .equal(false);
      expect(buildVerifyForm(REQUEST).has("constructorArguements")).to.equal(false);
    });

    it("sends the fully-qualified contract name so an ambiguous bytecode match resolves", () => {
      // RushoodTimelock's bytecode also matches OpenZeppelin's TimelockController; without
      // the path, verification fails with "More than one contract was found".
      const form = buildVerifyForm({
        ...REQUEST,
        contractName: "contracts/governance/RushoodTimelock.sol:RushoodTimelock",
      });

      expect(form.get("contractname")).to.equal(
        "contracts/governance/RushoodTimelock.sol:RushoodTimelock",
      );
    });

    it("submits as standard JSON input with the optimizer settings the deploy used", () => {
      const form = buildVerifyForm(REQUEST);

      expect(form.get("codeformat")).to.equal("solidity-standard-json-input");
      expect(form.get("action")).to.equal("verifysourcecode");
      expect(form.get("optimizationUsed")).to.equal("1");
      expect(form.get("runs")).to.equal("200");
      expect(form.get("sourceCode")).to.equal('{"language":"Solidity"}');
    });

    it("reports the optimizer as off when it was off", () => {
      const form = buildVerifyForm({ ...REQUEST, optimizer: { enabled: false, runs: 200 } });

      expect(form.get("optimizationUsed")).to.equal("0");
    });
  });

  describe("interpretSubmit", () => {
    it("returns the guid when the submission is queued", () => {
      expect(interpretSubmit({ status: "1", result: "abc123", message: "OK" })).to.deep.equal({
        state: "queued",
        guid: "abc123",
      });
    });

    /** Re-running the script must be safe, so this counts as success, not an error. */
    it("treats an already-verified contract as success", () => {
      expect(
        interpretSubmit({
          status: "0",
          result: "Smart-contract already verified.",
          message: "Smart-contract already verified.",
        }),
      ).to.deep.equal({ state: "already-verified" });
    });

    it("surfaces any other rejection as an error with its message", () => {
      expect(
        interpretSubmit({ status: "0", result: null, message: "Invalid compiler version" }),
      ).to.deep.equal({ state: "error", message: "Invalid compiler version" });
    });
  });

  describe("interpretPoll", () => {
    it("recognises success", () => {
      expect(interpretPoll({ status: "1", result: "Pass - Verified" })).to.equal("verified");
    });

    it("recognises the opaque failure Blockscout returns", () => {
      expect(interpretPoll({ status: "1", result: "Fail - Unable to verify" })).to.equal("failed");
    });

    it("keeps waiting while queued", () => {
      expect(interpretPoll({ status: "1", result: "Pending in queue" })).to.equal("pending");
    });
  });

  describe("verifyContract", () => {
    /** A fetch stand-in that replays a scripted sequence of JSON bodies. */
    function scriptedFetch(bodies: unknown[]) {
      const calls: string[] = [];
      let i = 0;
      return {
        calls,
        fetch: async (url: string) => {
          calls.push(url);
          const body = bodies[Math.min(i++, bodies.length - 1)];
          return { ok: true, json: async () => body } as never;
        },
      };
    }

    it("polls until the contract verifies", async () => {
      const { fetch } = scriptedFetch([
        { status: "1", result: "guid-1", message: "OK" },
        { status: "1", result: "Pending in queue" },
        { status: "1", result: "Pass - Verified" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
      });

      expect(result).to.deep.equal({ state: "verified" });
    });

    it("reports failure rather than hanging when Blockscout rejects the source", async () => {
      const { fetch } = scriptedFetch([
        { status: "1", result: "guid-1", message: "OK" },
        { status: "1", result: "Fail - Unable to verify" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
      });

      expect(result.state).to.equal("failed");
    });

    it("short-circuits when the contract is already verified", async () => {
      const { fetch, calls } = scriptedFetch([
        { status: "0", result: "Smart-contract already verified.", message: "Smart-contract already verified." },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
      });

      expect(result).to.deep.equal({ state: "already-verified" });
      expect(calls).to.have.lengthOf(1);
    });

    /**
     * Observed on the real explorer: RushoodGame and RushoodVesting reported
     * "Fail - Unable to verify" on one run and verified on the next, with byte-identical
     * submissions. Since the failure is opaque, a single attempt cannot tell a transient
     * queue fault from a genuine mismatch - so retry rather than report a false failure
     * and make someone re-run the launch script by hand.
     */
    it("retries an opaque failure before giving up on it", async () => {
      const { fetch } = scriptedFetch([
        { status: "1", result: "guid-1", message: "OK" },
        { status: "1", result: "Fail - Unable to verify" },
        { status: "1", result: "guid-2", message: "OK" },
        { status: "1", result: "Pass - Verified" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
        attempts: 2,
      });

      expect(result).to.deep.equal({ state: "verified" });
    });

    it("reports failure once the retries are exhausted", async () => {
      const { fetch } = scriptedFetch([
        { status: "1", result: "guid-1", message: "OK" },
        { status: "1", result: "Fail - Unable to verify" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
        attempts: 2,
      });

      expect(result.state).to.equal("failed");
    });

    /** A rejected submission (bad compiler version, say) is not worth retrying. */
    it("does not retry a submission Blockscout refused outright", async () => {
      const { fetch, calls } = scriptedFetch([
        { status: "0", result: null, message: "Invalid compiler version" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
        attempts: 3,
      });

      expect(result.state).to.equal("failed");
      expect(calls).to.have.lengthOf(1);
    });

    /** Without a bound, a stuck queue would hang the launch script indefinitely. */
    it("gives up after the poll budget instead of waiting forever", async () => {
      const { fetch } = scriptedFetch([
        { status: "1", result: "guid-1", message: "OK" },
        { status: "1", result: "Pending in queue" },
      ]);

      const result = await verifyContract("https://explorer.example", REQUEST, {
        fetch,
        waitMs: 0,
        maxPolls: 3,
      });

      expect(result.state).to.equal("timeout");
    });
  });
});
