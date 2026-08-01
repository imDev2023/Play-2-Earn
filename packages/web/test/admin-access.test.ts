import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { operatorAccess } from "../lib/admin/access";

/**
 * Who is allowed to drive the console, and by which route.
 *
 * The console is gated to the multisig, but "the multisig" means different things
 * depending on how far a deployment has got: before the #22 handoff the deployer key
 * still holds `governance` directly, and afterwards policy lives behind the Timelock
 * with the Safe as its proposer. Both are real states of a real deployment, so the
 * gate reports which one it is looking at rather than assuming the finished shape.
 */

const SAFE = "0xabc1111111111111111111111111111111111111" as Address;
const TIMELOCK = "0x2222222222222222222222222222222222222222" as Address;
const DEPLOYER = "0x3333333333333333333333333333333333333333" as Address;
const OUTSIDER = "0x4444444444444444444444444444444444444444" as Address;

describe("operatorAccess", () => {
  it("locks out an account holding none of the roles", () => {
    const access = operatorAccess({
      account: OUTSIDER,
      governance: TIMELOCK,
      guardian: SAFE,
      timelock: TIMELOCK,
      isProposer: false,
      isExecutor: false,
    });
    assert.equal(access.authorized, false);
    assert.deepEqual(access.roles, []);
    assert.equal(access.canQueue, false);
    assert.equal(access.canExecuteQueued, false);
    assert.equal(access.canPause, false);
    assert.equal(access.canChangeParamsDirectly, false);
  });

  it("locks out a disconnected visitor", () => {
    const access = operatorAccess({ governance: TIMELOCK, guardian: SAFE, timelock: TIMELOCK });
    assert.equal(access.authorized, false);
    assert.equal(access.mode, "timelock");
  });

  it("reports 'unknown' until the roles have been read from chain", () => {
    // A dead RPC must not read as "no timelock, govern directly" - that would invite
    // an operator to try a call the chain would reject.
    const access = operatorAccess({ account: SAFE });
    assert.equal(access.mode, "unknown");
    assert.equal(access.authorized, false);
  });

  it("gives the Safe the queue, execute and pause powers once governance is the timelock", () => {
    const access = operatorAccess({
      account: SAFE,
      governance: TIMELOCK,
      guardian: SAFE,
      timelock: TIMELOCK,
      isProposer: true,
      isExecutor: true,
      isCanceller: true,
    });
    assert.equal(access.authorized, true);
    assert.equal(access.mode, "timelock");
    assert.deepEqual(access.roles, ["guardian", "proposer", "executor", "canceller"]);
    assert.equal(access.canQueue, true);
    assert.equal(access.canExecuteQueued, true);
    // The way out of a mistake - OZ grants CANCELLER alongside PROPOSER.
    assert.equal(access.canCancel, true);
    assert.equal(access.canPause, true);
    // Params never go direct once the timelock governs - the game would reject it.
    assert.equal(access.canChangeParamsDirectly, false);
  });

  it("separates the proposer and executor powers", () => {
    const proposerOnly = operatorAccess({
      account: SAFE,
      governance: TIMELOCK,
      guardian: OUTSIDER,
      timelock: TIMELOCK,
      isProposer: true,
      isExecutor: false,
    });
    assert.deepEqual(proposerOnly.roles, ["proposer"]);
    assert.equal(proposerOnly.canQueue, true);
    assert.equal(proposerOnly.canExecuteQueued, false);
    assert.equal(proposerOnly.canPause, false);
  });

  it("lets a pre-handoff deployer govern directly, and says so", () => {
    // Right after deploy-skeleton without GOVERNANCE_SAFE, governance and guardian are
    // both the deployer key. That is a legitimate (if temporary) operating state.
    const access = operatorAccess({
      account: DEPLOYER,
      governance: DEPLOYER,
      guardian: DEPLOYER,
    });
    assert.equal(access.mode, "direct");
    assert.equal(access.authorized, true);
    assert.deepEqual(access.roles, ["governance", "guardian"]);
    assert.equal(access.canChangeParamsDirectly, true);
    assert.equal(access.canPause, true);
    // There is no timelock to queue against.
    assert.equal(access.canQueue, false);
  });

  it("reports a governance holder that is neither you nor the timelock as foreign", () => {
    const access = operatorAccess({
      account: SAFE,
      governance: DEPLOYER,
      guardian: SAFE,
      timelock: TIMELOCK,
      isProposer: true,
    });
    assert.equal(access.mode, "foreign");
    // The timelock holds the proposer role but not governance, so queueing a param
    // change through it would execute a call the game rejects.
    assert.equal(access.canQueue, false);
    // The pause role is independent of who governs, so it still works.
    assert.equal(access.canPause, true);
    assert.equal(access.authorized, true);
  });

  it("compares addresses case-insensitively", () => {
    const access = operatorAccess({
      account: SAFE.toUpperCase().replace("0X", "0x") as Address,
      governance: DEPLOYER,
      guardian: SAFE,
    });
    assert.equal(access.canPause, true);
  });
});
