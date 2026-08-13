import { expect } from "chai";
import {
  buildChecklistRecord,
  checklistLine,
  type StackAddresses,
} from "../scripts/lib/checklist-record";

/**
 * The published address list must not attribute an old checklist run to new addresses.
 *
 * The 2026-08-13 testnet redeploy did exactly that: six new addresses published under
 * "23/23 checks passed (2026-07-28)", because the publisher tested only that
 * `deployments/checklist-<network>.json` existed. The filename is per network, a redeploy
 * does not change the network, and the previous stack's record was still sitting there
 * while the new stack's checklist had an hour left to run.
 *
 * The round-trip tests are the ones that matter. An earlier version of this file tested
 * only the reader, and deleting the writer's stamp left the whole suite green - a failure
 * that would have been silent and permanent, since every later publish would read "not
 * run" forever with nothing red to say why. Testing one half of a join tests neither.
 */

const DEPLOYED: StackAddresses = {
  rush: "0xDc0B7143528964953a1A8b9f999DAc065542bA43",
  treasury: "0xd7442F1f4CD8c89cD023fbbc9aa6051b69e17a71",
  game: "0x84DD77034E1eDFEf6A26a5aAbb0036FA1F4b56aA",
  vesting: "0xA6da3D06793c978c91C356c3b4A9073a3aa25b55",
  lpLock: "0xd86A45CE6EC66099508418e8beF5CBD62383B395",
  timelock: "0x89e62FA596e29126E66E272095B376c6a8267Ded",
};

/** The stack the 2026-08-13 redeploy replaced. */
const SUPERSEDED: StackAddresses = {
  rush: "0x0e589f857795257B0C288B2354cBF57F9D9276CD",
  treasury: "0xF3cc13a111AB630006D651D7bA5a2af3c3a9342A",
  game: "0x642cf500f1ee31E3F5bDe228d448493Be35DD29C",
  vesting: "0x50daA37865660fA8Ee6C0A90B9c725aF247b5625",
  lpLock: "0x9CEa890dB90a0AAEeE11FaA3f33aDc58313C430e",
  timelock: "0xa0253a040BA9303FbC3387B89DDeC927f7A778Dc",
};

function record(stack: StackAddresses, overrides: Record<string, unknown> = {}) {
  return {
    ...buildChecklistRecord({
      network: "robinhoodTestnet",
      chainId: 46630,
      stack,
      passed: 23,
      total: 23,
      failures: [],
      ranAt: "2026-08-13T02:43:43.871Z",
    }),
    ...overrides,
  };
}

describe("checklist attribution (#47 address list)", () => {
  describe("the round trip - writer and reader together", () => {
    it("accepts a record the checklist wrote for the stack being published", () => {
      const line = checklistLine(record(DEPLOYED), DEPLOYED);

      expect(line).to.contain("**23/23 checks passed**");
      expect(line).to.contain("2026-08-13");
    });

    // This is the test that catches the stamp being dropped from the writer. It failed
    // to exist in the first version, and deleting the stamp left 308 tests green.
    it("refuses a record the checklist wrote for a different stack", () => {
      const line = checklistLine(record(SUPERSEDED), DEPLOYED);

      expect(line).to.contain("Not run against this deployment");
      expect(line).to.not.contain("23/23 checks passed");
    });

    it("stamps every address the run exercised, not only the game", () => {
      const written = buildChecklistRecord({
        network: "robinhoodTestnet",
        chainId: 46630,
        stack: DEPLOYED,
        passed: 23,
        total: 23,
        failures: [],
      });

      expect(written.stack).to.deep.equal(DEPLOYED);
    });
  });

  describe("attribution", () => {
    it("matches case-insensitively, since a checksummed address is the same address", () => {
      const lowered = Object.fromEntries(
        Object.entries(DEPLOYED).map(([k, v]) => [k, v.toLowerCase()]),
      ) as unknown as StackAddresses;

      expect(checklistLine(record(lowered), DEPLOYED)).to.contain("**23/23 checks passed**");
    });

    it("refuses when only one address differs, because the run covers the whole stack", () => {
      const swappedTreasury = { ...DEPLOYED, treasury: SUPERSEDED.treasury };

      const line = checklistLine(record(swappedTreasury), DEPLOYED);

      expect(line).to.contain("Not run against this deployment");
      expect(line).to.not.contain("23/23 checks passed");
    });

    it("names the superseded game so the mismatch is checkable", () => {
      const line = checklistLine(record(SUPERSEDED), DEPLOYED);

      expect(line).to.contain(SUPERSEDED.game);
      expect(line).to.contain("superseded");
    });

    it("refuses a record written before the stack was stamped", () => {
      const line = checklistLine(record(DEPLOYED, { stack: undefined }), DEPLOYED);

      expect(line).to.contain("Not run against this deployment");
      expect(line).to.contain("does not record which deployment");
      expect(line).to.not.contain("23/23 checks passed");
    });

    it("says plainly that no checklist has run at all", () => {
      const line = checklistLine(null, DEPLOYED);

      expect(line).to.contain("Not run against this deployment");
      expect(line).to.contain("scripts/launch-checklist.ts");
    });
  });

  describe("malformed records, which are parsed from disk unvalidated", () => {
    it("does not throw when an address is null", () => {
      const line = checklistLine(
        record(DEPLOYED, { stack: { ...DEPLOYED, game: null } }),
        DEPLOYED,
      );

      expect(line).to.contain("Not run against this deployment");
    });

    it("does not throw when an address is not a string", () => {
      const line = checklistLine(record(DEPLOYED, { stack: { ...DEPLOYED, game: 42 } }), DEPLOYED);

      expect(line).to.contain("Not run against this deployment");
    });

    it("treats an empty address as unusable rather than as a match", () => {
      const bothEmpty = { ...DEPLOYED, game: "" };

      const line = checklistLine(record(DEPLOYED, { stack: bothEmpty }), {
        ...DEPLOYED,
        game: "",
      });

      expect(line).to.contain("Not run against this deployment");
    });

    it("does not render an attributed record that carries no result", () => {
      const line = checklistLine(
        record(DEPLOYED, { passed: undefined, total: undefined }),
        DEPLOYED,
      );

      expect(line).to.contain("records no result");
      expect(line).to.not.contain("undefined");
    });
  });

  it("names the failures when an attributed run did not pass", () => {
    const line = checklistLine(
      record(DEPLOYED, { passed: 21, total: 23, failures: ["guardian can unpause", "refund"] }),
      DEPLOYED,
    );

    expect(line).to.contain("**21/23 checks passed**");
    expect(line).to.contain("guardian can unpause, refund");
  });
});
