import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeFunctionData, parseUnits } from "viem";
import {
  ADMIN_OPS,
  adminOp,
  describeAdminCall,
  encodeAdminOp,
  MAX_ECONOMIC_RATIO,
  parseAdminOp,
  preflightAdminOp,
} from "../lib/admin/ops";
import { GAME_ABI } from "../lib/contracts";

/**
 * The admin operations catalogue: what an operator can change, what the game will
 * accept, and how a change becomes calldata.
 *
 * Validation mirrors the contract's own bounds deliberately. A queued change waits out
 * the timelock delay before the chain gets to reject it, so a value the game can never
 * accept has to be caught here - two days before it would otherwise surface as a
 * reverted execution.
 */

function ok(result: ReturnType<typeof parseAdminOp>) {
  assert.equal(
    result.ok,
    true,
    // BigInt args make JSON.stringify throw, which would mask the real assertion.
    result.ok ? "" : `expected a clean parse, got ${result.errors.map((e) => e.message).join("; ")}`,
  );
  return result as Extract<typeof result, { ok: true }>;
}

function errorsFor(result: ReturnType<typeof parseAdminOp>): string[] {
  assert.equal(result.ok, false, "expected the parse to fail");
  return (result as Extract<typeof result, { ok: false }>).errors.map((e) => e.field);
}

describe("the operations catalogue", () => {
  it("covers every sensitive parameter the game exposes to governance", () => {
    assert.deepEqual(
      ADMIN_OPS.map((op) => op.id),
      [
        "setBurnRate",
        "setEconomicsGovernable",
        "setMinBet",
        "setEdge",
        "setSolvencyCap",
        "setTreasuryFloor",
        "burnTreasuryProfit",
      ],
    );
  });

  it("marks which operations the game only accepts with the economy unlocked", () => {
    // The #22 opt-in flag: these four revert with EconomicsLocked until it is on.
    const locked = ADMIN_OPS.filter((op) => op.needsEconomicsUnlocked).map((op) => op.id);
    assert.deepEqual(locked, ["setMinBet", "setEdge", "setSolvencyCap", "setTreasuryFloor"]);
  });

  it("marks which operations the game refuses while a bet is in flight", () => {
    const idleOnly = ADMIN_OPS.filter((op) => op.needsIdleGame).map((op) => op.id);
    assert.deepEqual(idleOnly, [
      "setMinBet",
      "setEdge",
      "setSolvencyCap",
      "setTreasuryFloor",
      "burnTreasuryProfit",
    ]);
  });
});

describe("parseAdminOp", () => {
  it("accepts a burn rate inside the contract's ceiling", () => {
    assert.deepEqual(ok(parseAdminOp("setBurnRate", { newBps: "100" })).args, [100n]);
    // Zero is a real setting: it switches the per-play burn off.
    assert.deepEqual(ok(parseAdminOp("setBurnRate", { newBps: "0" })).args, [0n]);
    assert.deepEqual(ok(parseAdminOp("setBurnRate", { newBps: "1000" })).args, [1000n]);
  });

  it("rejects a burn rate above MAX_BURN_RATE_BPS rather than queueing a doomed call", () => {
    const result = parseAdminOp("setBurnRate", { newBps: "1001" });
    assert.deepEqual(errorsFor(result), ["newBps"]);
    assert.match(
      (result as { errors: { message: string }[] }).errors[0].message,
      /1000 bps|10%/,
    );
  });

  it("rejects an edge or cap above MAX_ECONOMIC_RATIO rather than queueing a doomed call", () => {
    // #47 packed edgeNum/edgeDen/solvencyCapDen into 56 bits each, so the contract now
    // reverts with InvalidEconomics above type(uint56).max. Without this mirror the
    // console would happily queue a timelock operation that can only revert on execution
    // - the same failure mode the burn-rate bound above exists to prevent.
    const tooBig = (MAX_ECONOMIC_RATIO + 1n).toString();

    assert.deepEqual(errorsFor(parseAdminOp("setSolvencyCap", { den: tooBig })), ["den"]);
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: "1", den: tooBig })), ["den"]);

    // `num` carries the bound as well, and it pins in isolation: a failed bound leaves
    // the parse incomplete, and `crossCheck` (which is what would otherwise fire on
    // `num > den`) only runs on a complete parse. So an over-wide `num` against a
    // perfectly ordinary `den` reports exactly one field.
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: tooBig, den: "100" })), ["num"]);

    // Both over-wide reports both, per "reports every bad field at once" below.
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: tooBig, den: tooBig })), [
      "num",
      "den",
    ]);

    // The ceiling itself is still accepted, so the bound rejects only what cannot fit.
    const atCeiling = parseAdminOp("setSolvencyCap", { den: MAX_ECONOMIC_RATIO.toString() });
    assert.deepEqual(ok(atCeiling).args, [MAX_ECONOMIC_RATIO]);
  });

  it("reads RUSH amounts as decimal token amounts, not raw wei", () => {
    // An operator types "2.5", meaning 2.5 RUSH. Getting this wrong by 1e18 is the
    // single most expensive typo available on this page.
    assert.deepEqual(ok(parseAdminOp("setMinBet", { newMinBet: "2.5" })).args, [
      parseUnits("2.5", 18),
    ]);
    assert.deepEqual(ok(parseAdminOp("setTreasuryFloor", { newFloor: "95000" })).args, [
      parseUnits("95000", 18),
    ]);
    assert.deepEqual(ok(parseAdminOp("burnTreasuryProfit", { amount: "1000" })).args, [
      parseUnits("1000", 18),
    ]);
  });

  it("rejects the values the game's InvalidEconomics guard would reject", () => {
    assert.deepEqual(errorsFor(parseAdminOp("setMinBet", { newMinBet: "0" })), ["newMinBet"]);
    assert.deepEqual(errorsFor(parseAdminOp("setTreasuryFloor", { newFloor: "0" })), ["newFloor"]);
    assert.deepEqual(errorsFor(parseAdminOp("setSolvencyCap", { den: "0" })), ["den"]);
    assert.deepEqual(errorsFor(parseAdminOp("burnTreasuryProfit", { amount: "0" })), ["amount"]);
  });

  it("holds the edge to a real house edge: 0 < num <= den", () => {
    assert.deepEqual(ok(parseAdminOp("setEdge", { num: "95", den: "100" })).args, [95n, 100n]);
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: "0", den: "100" })), ["num"]);
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: "101", den: "100" })), ["num"]);
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: "95", den: "0" })), ["den"]);
  });

  it("reports every bad field at once rather than stopping at the first", () => {
    assert.deepEqual(errorsFor(parseAdminOp("setEdge", { num: "", den: "nonsense" })), [
      "num",
      "den",
    ]);
  });

  it("parses the economics flag as a boolean", () => {
    assert.deepEqual(ok(parseAdminOp("setEconomicsGovernable", { enabled: "true" })).args, [true]);
    assert.deepEqual(ok(parseAdminOp("setEconomicsGovernable", { enabled: "false" })).args, [false]);
    assert.deepEqual(errorsFor(parseAdminOp("setEconomicsGovernable", { enabled: "maybe" })), [
      "enabled",
    ]);
  });

  it("rejects a malformed amount instead of silently reading it as zero", () => {
    assert.deepEqual(errorsFor(parseAdminOp("setMinBet", { newMinBet: "1e18" })), ["newMinBet"]);
    assert.deepEqual(errorsFor(parseAdminOp("setMinBet", { newMinBet: "-5" })), ["newMinBet"]);
    assert.deepEqual(errorsFor(parseAdminOp("setBurnRate", { newBps: "12.5" })), ["newBps"]);
  });

  it("requires a value for every field", () => {
    assert.deepEqual(errorsFor(parseAdminOp("setBurnRate", {})), ["newBps"]);
  });
});

describe("encodeAdminOp", () => {
  it("encodes a call the game's own ABI decodes back to the same arguments", () => {
    for (const [id, raw] of [
      ["setBurnRate", { newBps: "100" }],
      ["setMinBet", { newMinBet: "2.5" }],
      ["setEdge", { num: "95", den: "100" }],
      ["setSolvencyCap", { den: "200" }],
      ["setTreasuryFloor", { newFloor: "95000" }],
      ["setEconomicsGovernable", { enabled: "true" }],
      ["burnTreasuryProfit", { amount: "1000" }],
    ] as const) {
      const parsed = ok(parseAdminOp(id, raw));
      const decoded = decodeFunctionData({ abi: GAME_ABI, data: encodeAdminOp(id, parsed.args) });
      assert.equal(decoded.functionName, id);
      assert.deepEqual([...(decoded.args ?? [])], [...parsed.args]);
    }
  });

  it("keeps setEdge's argument order - a flipped num/den is a payout bug", () => {
    const data = encodeAdminOp("setEdge", [95n, 100n]);
    const decoded = decodeFunctionData({ abi: GAME_ABI, data });
    assert.deepEqual([...(decoded.args ?? [])], [95n, 100n]);
  });
});

describe("describeAdminCall", () => {
  it("reads a queued operation back into plain language", () => {
    // The pending queue is rebuilt from CallScheduled logs, so what an operator is
    // asked to approve has to be recovered from calldata, not remembered from the form.
    const described = describeAdminCall(encodeAdminOp("setBurnRate", [100n]));
    assert.equal(described?.id, "setBurnRate");
    assert.match(described!.detail, /100 bps/);
    assert.match(described!.detail, /1%/);
  });

  it("renders RUSH amounts as token amounts", () => {
    const described = describeAdminCall(encodeAdminOp("setMinBet", [parseUnits("2.5", 18)]));
    assert.match(described!.detail, /2\.5 RUSH/);
  });

  it("renders the edge as its multiplier, the way the ladder quotes it", () => {
    const described = describeAdminCall(encodeAdminOp("setEdge", [90n, 100n]));
    assert.match(described!.detail, /90\/100/);
    assert.match(described!.detail, /10% house edge/);
  });

  it("returns null for calldata this console did not build", () => {
    // An operation queued elsewhere (or against another contract) must not be
    // mislabelled as something familiar.
    assert.equal(describeAdminCall("0xdeadbeef"), null);
  });
});

describe("preflightAdminOp", () => {
  const state = {
    economicsGovernable: false,
    activeBetId: 0n,
    treasuryBalance: parseUnits("100000", 18),
    treasuryFloor: parseUnits("95000", 18),
  };

  it("is silent when the game will accept the call as things stand", () => {
    assert.deepEqual(preflightAdminOp("setBurnRate", [100n], state), []);
  });

  it("warns that an economic setter needs the economy unlocked first", () => {
    const warnings = preflightAdminOp("setMinBet", [parseUnits("2", 18)], state);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /setEconomicsGovernable/);
  });

  it("stops warning once the economy is unlocked", () => {
    assert.deepEqual(
      preflightAdminOp("setMinBet", [parseUnits("2", 18)], { ...state, economicsGovernable: true }),
      [],
    );
  });

  it("warns that a bet in flight blocks the change", () => {
    const warnings = preflightAdminOp("burnTreasuryProfit", [parseUnits("100", 18)], {
      ...state,
      activeBetId: 12n,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /bet #12/);
  });

  it("warns when a profit-burn exceeds the headroom above the treasury floor", () => {
    // The floor is the solvency reserve the payout cap depends on - the contract will
    // not let it be burned away, so say so before the delay is spent.
    const warnings = preflightAdminOp("burnTreasuryProfit", [parseUnits("6000", 18)], state);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /5000 RUSH/);
  });

  it("allows a burn that exactly empties the headroom", () => {
    assert.deepEqual(preflightAdminOp("burnTreasuryProfit", [parseUnits("5000", 18)], state), []);
  });

  it("collects several warnings when more than one applies", () => {
    const warnings = preflightAdminOp("setEdge", [90n, 100n], { ...state, activeBetId: 3n });
    assert.equal(warnings.length, 2);
  });
});

describe("adminOp", () => {
  it("looks up a spec by id", () => {
    assert.equal(adminOp("setBurnRate").label.length > 0, true);
    assert.equal(adminOp("setBurnRate").fields[0].name, "newBps");
  });
});
