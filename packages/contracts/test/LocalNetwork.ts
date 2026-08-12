import { expect } from "chai";
import {
  LOCAL_CHAIN_ID,
  assertLocalDevChain,
  isLocalNetwork,
  localRpcUrl,
} from "../scripts/lib/local-network";

/**
 * Guards the `localhost` network entry and the local-chain check on the deploy path.
 *
 * The hazard is specific and was hit for real: Hardhat has no `localhost` entry unless
 * one is written, so `--network localhost` falls back to a built-in `127.0.0.1:8545`.
 * Any other project's node on that port therefore inherits this project's launch
 * deployment - during a rehearsal, 8545 was held by an unrelated `anvil` forking BNB
 * testnet, and nothing in the deploy path would have noticed.
 *
 * Two independent defences, because they fail differently. `localRpcUrl` lets a run move
 * off a busy port; `assertLocalDevChain` refuses to deploy when whatever answered is not
 * a local dev chain. The second is the one that catches the case where nobody thought to
 * set the first.
 */
describe("local network pinning", () => {
  describe("localRpcUrl", () => {
    it("defaults to the port Hardhat's own node listens on", () => {
      expect(localRpcUrl({})).to.equal("http://127.0.0.1:8545");
    });

    it("moves to LOCAL_RPC_PORT when the default port is taken", () => {
      expect(localRpcUrl({ LOCAL_RPC_PORT: "8548" })).to.equal("http://127.0.0.1:8548");
    });

    it("lets LOCAL_RPC_URL name a host, and prefers it over the port", () => {
      expect(
        localRpcUrl({ LOCAL_RPC_URL: "http://10.0.0.4:9001", LOCAL_RPC_PORT: "8548" }),
      ).to.equal("http://10.0.0.4:9001");
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
      expect(() => localRpcUrl({ LOCAL_RPC_PORT: "" })).to.throw(/LOCAL_RPC_PORT/);
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

  describe("assertLocalDevChain", () => {
    it("accepts a genuine local dev chain", () => {
      expect(() => assertLocalDevChain("localhost", LOCAL_CHAIN_ID)).to.not.throw();
      expect(() => assertLocalDevChain("hardhat", LOCAL_CHAIN_ID)).to.not.throw();
    });

    /** The rehearsal case: BNB testnet is chain 97, and it was answering on 8545. */
    it("refuses to deploy when a foreign chain answers on the local port", () => {
      expect(() => assertLocalDevChain("localhost", 97n)).to.throw(/chain 97/);
    });

    /**
     * Named explicitly because the failure it prevents is the expensive direction: a
     * mainnet chain id reached under the `localhost` name means the deployment believed
     * it was a rehearsal.
     */
    it("names the mismatch rather than reporting a generic failure", () => {
      expect(() => assertLocalDevChain("localhost", 4663n)).to.throw(/4663/);
      expect(() => assertLocalDevChain("localhost", 4663n)).to.throw(/31337/);
    });

    it("leaves the public networks alone, whatever they report", () => {
      expect(() => assertLocalDevChain("robinhoodTestnet", 46630n)).to.not.throw();
      expect(() => assertLocalDevChain("robinhoodMainnet", 4663n)).to.not.throw();
    });
  });

  /**
   * The config is the half that has to be *wired*, and a hardcoded url would satisfy any
   * assertion written against the default value alone. So this reloads the config under a
   * changed environment: it passes only if the config actually calls `localRpcUrl`.
   */
  describe("hardhat.config.ts", () => {
    const CONFIG = require.resolve("../hardhat.config");

    function loadConfig(): { networks?: Record<string, { url?: string }> } {
      delete require.cache[CONFIG];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("../hardhat.config").default;
    }

    afterEach(() => {
      delete process.env.LOCAL_RPC_PORT;
      delete require.cache[CONFIG];
    });

    it("declares a localhost network, so --network localhost cannot fall back", () => {
      expect(loadConfig().networks?.localhost?.url).to.equal("http://127.0.0.1:8545");
    });

    it("derives that url from the environment, not a literal", () => {
      process.env.LOCAL_RPC_PORT = "8548";
      expect(loadConfig().networks?.localhost?.url).to.equal("http://127.0.0.1:8548");
    });
  });
});
