import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { localChainEnv } from "../playwright.base";
import connectedConfig from "../playwright.connected.config";
import disconnectedConfig from "../playwright.config";

/**
 * Both E2E suites must build the app against the local Hardhat chain, whatever the
 * machine running them has in its gitignored `packages/web/.env`.
 *
 * This is the harness twin of `chain-pinning.test.ts`. That one guards runtime reads
 * from following the connected wallet's chain; this one guards the *build* from
 * following a developer's `.env`, because Next inlines `NEXT_PUBLIC_*` at compile time
 * and fills anything the shell leaves unset from that file.
 *
 * The failure it exists to stop is not a red suite - it is a suite that is red only on
 * a working machine. CI has no `.env`, so a `.env` naming the testnet turns twelve of
 * nineteen connected specs into "Switch network to play" locally and nothing at all in
 * CI, which points every suspicion at the tests instead of at the environment.
 */
describe("E2E chain environment", () => {
  it("pins the app's chain to the local node rather than inheriting one", () => {
    assert.equal(localChainEnv({}).NEXT_PUBLIC_CHAIN_ID, "31337");
  });

  /**
   * "" is what `lib/addresses.ts` reads as unset, which is the only way to reach the
   * committed skeleton entry on a machine whose `.env` supplies an override. Omitting
   * the keys instead would let the `.env` value through.
   */
  it("blanks the address overrides instead of omitting them", () => {
    const env = localChainEnv({});
    assert.equal(env.NEXT_PUBLIC_GAME_ADDRESS, "");
    assert.equal(env.NEXT_PUBLIC_RUSH_ADDRESS, "");
    assert.ok("NEXT_PUBLIC_GAME_ADDRESS" in env);
    assert.ok("NEXT_PUBLIC_RUSH_ADDRESS" in env);
  });

  it("defaults the app's transport to the default Hardhat port", () => {
    assert.equal(localChainEnv({}).NEXT_PUBLIC_RPC_URL, "http://127.0.0.1:8545");
  });

  /**
   * The half that was missing. `LOCAL_RPC_PORT` already moved the node and the wallet
   * fixture; leaving the app behind on 8545 made every read answer from whatever held
   * that port while writes went to the relocated node.
   */
  it("follows LOCAL_RPC_PORT so a relocated node takes the app with it", () => {
    assert.equal(
      localChainEnv({ LOCAL_RPC_PORT: "8548" }).NEXT_PUBLIC_RPC_URL,
      "http://127.0.0.1:8548",
    );
  });

  it("lets an explicit transport win over the derived one", () => {
    assert.equal(
      localChainEnv({ LOCAL_RPC_PORT: "8548", NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9999" })
        .NEXT_PUBLIC_RPC_URL,
      "http://127.0.0.1:9999",
    );
  });

  /**
   * An empty string is how a shell suppresses a value, and it cannot be told from
   * unset by `??`. Both knobs read it as absent so a suppressed value falls back to
   * the default rather than producing `http://127.0.0.1:`.
   */
  it("treats an empty value as unset rather than as a port", () => {
    assert.equal(
      localChainEnv({ LOCAL_RPC_PORT: "", NEXT_PUBLIC_RPC_URL: "" }).NEXT_PUBLIC_RPC_URL,
      "http://127.0.0.1:8545",
    );
  });

  /**
   * Asserted on the configs themselves, not just on the helper: a helper nothing wires
   * up is the shape `checklist-record.ts` shipped in, where the reader was covered by
   * six tests and deleting the writer's half left every test green.
   */
  for (const [name, config] of [
    ["connected", connectedConfig],
    ["disconnected", disconnectedConfig],
  ] as const) {
    it(`is wired into the ${name} config's web server`, () => {
      const server = config.webServer;
      assert.ok(server && !Array.isArray(server), `${name} config declares no single webServer`);
      // The literal first. `deepEqual` against `localChainEnv()` alone would hold even
      // if the helper returned `{}`, which is the shape where both sides of an assertion
      // come from the thing under test and it asserts nothing.
      assert.equal(server.env?.NEXT_PUBLIC_CHAIN_ID, "31337");
      assert.deepEqual(server.env, localChainEnv());
    });
  }
});
