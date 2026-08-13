import { expect } from "chai";
import { checklistLine } from "../scripts/lib/checklist-record";

/**
 * The published address list must not attribute an old checklist run to new addresses.
 *
 * The 2026-08-13 testnet redeploy did exactly that: six new addresses published under
 * "23/23 checks passed (2026-07-28)", because `checklistLine` tested only that
 * `deployments/checklist-<network>.json` existed. The filename is per network, and a
 * redeploy does not change the network, so the previous stack's record was still sitting
 * there. The new stack's checklist was still running.
 *
 * A pass claim on a money contract's public record is the thing least able to afford
 * being about something else, so these hold the attribution still rather than the
 * wording.
 */

const GAME = "0x84DD77034E1eDFEf6A26a5aAbb0036FA1F4b56aA";
const OLD_GAME = "0x642cf500f1ee31E3F5bDe228d448493Be35DD29C";

const PASSING = {
  network: "robinhoodTestnet",
  chainId: 46630,
  game: GAME,
  passed: 23,
  total: 23,
  ranAt: "2026-08-13T03:41:00.000Z",
  failures: [],
};

describe("checklist attribution (#57 redeploy)", () => {
  it("reports a pass only when the record names the game being published", () => {
    const line = checklistLine(PASSING, GAME);

    expect(line).to.contain("**23/23 checks passed**");
    expect(line).to.contain("2026-08-13");
  });

  it("matches the address case-insensitively, since checksums differ by source", () => {
    const line = checklistLine({ ...PASSING, game: GAME.toLowerCase() }, GAME.toUpperCase());

    expect(line).to.contain("**23/23 checks passed**");
  });

  it("refuses to vouch when the record ran against the stack these addresses replaced", () => {
    const line = checklistLine(
      { ...PASSING, game: OLD_GAME, ranAt: "2026-07-28T20:07:43.001Z" },
      GAME,
    );

    expect(line).to.contain("Not run against this deployment");
    expect(line).to.contain(OLD_GAME);
    expect(line).to.contain("2026-07-28");
    // The bug in one sentence: a passing count must not survive a failed attribution.
    expect(line).to.not.contain("23/23 checks passed");
  });

  it("refuses to vouch for a record written before the game address was stamped", () => {
    const { game: _omitted, ...unstamped } = PASSING;
    const line = checklistLine(unstamped, GAME);

    expect(line).to.contain("Not run against this deployment");
    expect(line).to.contain("does not record which deployment");
    expect(line).to.not.contain("23/23 checks passed");
  });

  it("says plainly that no checklist has run at all", () => {
    const line = checklistLine(null, GAME);

    expect(line).to.contain("Not run against this deployment");
    expect(line).to.contain("scripts/launch-checklist.ts");
  });

  it("names the failures when an attributed run did not pass", () => {
    const line = checklistLine(
      { ...PASSING, passed: 21, total: 23, failures: ["guardian can unpause", "refund"] },
      GAME,
    );

    expect(line).to.contain("**21/23 checks passed**");
    expect(line).to.contain("guardian can unpause, refund");
  });
});
