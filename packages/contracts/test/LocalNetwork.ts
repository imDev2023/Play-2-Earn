import { expect } from "chai";
import { ethers } from "hardhat";
import { LOCAL_CHAIN_ID, isLocalNetwork, localRpcUrl } from "../scripts/lib/local-network";

/**
 * Guards the `localhost` network entry.
 *
 * The hazard is specific and was hit for real: Hardhat has no `localhost` entry unless
 * one is written, so `--network localhost` falls back to a built-in `127.0.0.1:8545`.
 * Any other project's node on that port therefore inherits this project's launch
 * deployment - during a rehearsal, 8545 was held by an unrelated `anvil` forking BNB
 * testnet, and nothing in the deploy path would have noticed.
 *
 * The enforcement is `chainId` on that entry, which makes Hardhat reject a foreign node
 * on the first request. `LOCAL_RPC_PORT` is what keeps that survivable, by allowing a run
 * to move off a port something else already holds.
 */
describe("local network pinning", () => {
  describe("localRpcUrl", () => {
    it("defaults to the port Hardhat's own node listens on", () => {
      expect(localRpcUrl({})).to.equal("http://127.0.0.1:8545");
    });

    it("moves to LOCAL_RPC_PORT when the default port is taken", () => {
      expect(localRpcUrl({ LOCAL_RPC_PORT: "8548" })).to.equal("http://127.0.0.1:8548");
    });

    /**
     * The `node` script expands `${LOCAL_RPC_PORT:-8545}`, which cannot tell empty from
     * unset. Treating them differently here would put the node on one port and every
     * client on another - a split that is harder to diagnose than the collision.
     */
    it("treats an empty value as unset, matching the shell the node script uses", () => {
      expect(localRpcUrl({ LOCAL_RPC_PORT: "" })).to.equal("http://127.0.0.1:8545");
    });

    /**
     * A typo'd port silently falling back to 8545 would reintroduce the exact bug this
     * module exists to remove, and would do it to someone who had explicitly tried to
     * avoid it.
     */
    it("rejects a malformed port rather than falling back to the default", () => {
      expect(() => localRpcUrl({ LOCAL_RPC_PORT: "85 48" })).to.throw(/LOCAL_RPC_PORT/);
      expect(() => localRpcUrl({ LOCAL_RPC_PORT: "0" })).to.throw(/LOCAL_RPC_PORT/);
      expect(() => localRpcUrl({ LOCAL_RPC_PORT: "70000" })).to.throw(/LOCAL_RPC_PORT/);
      expect(() => localRpcUrl({ LOCAL_RPC_PORT: "notaport" })).to.throw(/LOCAL_RPC_PORT/);
    });
  });

  describe("isLocalNetwork", () => {
    it("recognises the two local network names", () => {
      expect(isLocalNetwork("localhost")).to.equal(true);
      expect(isLocalNetwork("hardhat")).to.equal(true);
    });

    it("does not treat the public networks as local", () => {
      expect(isLocalNetwork("robinhoodTestnet")).to.equal(false);
      expect(isLocalNetwork("robinhoodMainnet")).to.equal(false);
    });
  });

  describe("hardhat.config.ts", () => {
    const CONFIG = require.resolve("../hardhat.config");

    function loadConfig(): {
      networks?: Record<string, { url?: string; chainId?: number }>;
    } {
      delete require.cache[CONFIG];
      return require("../hardhat.config").default;
    }

    /**
     * Cleared before as well as after. Only clearing afterwards would fail the default
     * case for anyone who had exported LOCAL_RPC_PORT in their shell - which is exactly
     * the person this feature exists for.
     */
    beforeEach(() => {
      delete process.env.LOCAL_RPC_PORT;
    });

    afterEach(() => {
      delete process.env.LOCAL_RPC_PORT;
      delete require.cache[CONFIG];
    });

    it("declares a localhost network, so --network localhost cannot fall back", () => {
      expect(loadConfig().networks?.localhost?.url).to.equal("http://127.0.0.1:8545");
    });

    /**
     * Reloads under a changed environment rather than comparing the default against
     * itself, so a hardcoded url fails this even though it would satisfy the test above.
     */
    it("derives that url from the environment, not a literal", () => {
      process.env.LOCAL_RPC_PORT = "8548";
      expect(loadConfig().networks?.localhost?.url).to.equal("http://127.0.0.1:8548");
    });

    /**
     * The whole enforcement, in one field. Hardhat wraps an HTTP network that declares a
     * chainId in `ChainIdValidatorProvider` and rejects a mismatch on the first request,
     * which is what covers tasks nobody added a check to.
     */
    it("pins the localhost chain id so Hardhat itself rejects a foreign node", () => {
      expect(loadConfig().networks?.localhost?.chainId).to.equal(31337);
    });

    /**
     * Asks the running node rather than restating the constant. A test that compared
     * LOCAL_CHAIN_ID to a hand-typed 31337 would hold for whatever value the constant
     * took, including a wrong one.
     */
    it("agrees with the chain id Hardhat's own network reports", async () => {
      expect((await ethers.provider.getNetwork()).chainId).to.equal(LOCAL_CHAIN_ID);
    });
  });
});
