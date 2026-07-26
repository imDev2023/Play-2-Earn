import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

/**
 * Chain configuration (#26).
 *
 * The point of these is the mainnet story: Robinhood Chain's mainnet endpoints are not
 * published, so the app must have *no* guessed URLs baked in and must say so plainly
 * rather than failing as an opaque network error. Testnet endpoints are real and stay
 * asserted so a future edit can't quietly break the working chain either.
 *
 * lib/chain reads process.env once, at module load, so the environment is cleared
 * *before* it is imported. Without that these assertions would pass or fail depending
 * on whoever's shell was running them — and the whole point is to prove the defaults
 * are safe, which an inherited NEXT_PUBLIC_ROBINHOOD_RPC_URL would mask.
 */

const OVERRIDES = [
  "NEXT_PUBLIC_ROBINHOOD_RPC_URL",
  "NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL",
  "NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL",
  "NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER_URL",
  "NEXT_PUBLIC_GAS_BRIDGE_URL",
  "NEXT_PUBLIC_GAS_FAUCET_URL",
  "NEXT_PUBLIC_UNISWAP_URL",
  "NEXT_PUBLIC_CHAIN_ID",
] as const;

let chain: typeof import("../lib/chain");

before(async () => {
  for (const key of OVERRIDES) delete process.env[key];
  chain = await import("../lib/chain");
});

const RUSH = "0x1111111111111111111111111111111111111111" as const;

describe("mainnet is not silently mis-configured", () => {
  it("ships no hard-coded mainnet RPC", () => {
    assert.equal(chain.robinhoodChain.rpcUrls.default.http[0], "");
  });

  it("ships no hard-coded mainnet explorer", () => {
    assert.equal(chain.robinhoodChain.blockExplorers?.default.url, "");
  });

  it("reports mainnet as unconfigured when no endpoints are supplied", () => {
    assert.equal(chain.MAINNET_ENDPOINTS_CONFIGURED, false);
  });

  it("explains the problem when the app targets mainnet without endpoints", () => {
    const error = chain.activeChainConfigError(chain.robinhoodChain.id);
    assert.ok(error, "expected a configuration error for mainnet");
    assert.match(error, /NEXT_PUBLIC_ROBINHOOD_RPC_URL/);
    assert.match(error, /4663/);
  });

  it("offers no dead gas link on an unconfigured mainnet", () => {
    assert.equal(chain.gasHelpUrl(chain.robinhoodChain.id), null);
  });
});

describe("testnet stays fully configured", () => {
  it("keeps a real RPC endpoint", () => {
    assert.match(chain.robinhoodTestnet.rpcUrls.default.http[0], /^https:\/\/rpc\.testnet\./);
  });

  it("keeps a real explorer", () => {
    assert.match(
      chain.robinhoodTestnet.blockExplorers?.default.url ?? "",
      /^https:\/\/explorer\.testnet\./,
    );
  });

  it("points a gasless player at the faucet", () => {
    const url = chain.gasHelpUrl(chain.robinhoodTestnet.id);
    assert.ok(url);
    assert.match(url, /faucet\.testnet\.chain\.robinhood\.com/);
  });

  it("raises no configuration error", () => {
    assert.equal(chain.activeChainConfigError(chain.robinhoodTestnet.id), null);
  });
});

describe("chain metadata", () => {
  it("defaults to the local hardhat chain so dev works out of the box", () => {
    assert.equal(chain.ACTIVE_CHAIN_ID, 31337);
  });

  it("knows all three chains", () => {
    assert.deepEqual(
      chain.CHAINS.map((c) => c.id).sort((a, b) => a - b),
      [4663, 31337, 46630],
    );
  });

  it("labels a known chain by name and an unknown one by id", () => {
    assert.equal(chain.chainLabel(46630), "Robinhood Chain Testnet");
    assert.equal(chain.chainLabel(999999), "Chain 999999");
  });

  it("has nowhere to send a local player for gas", () => {
    assert.equal(chain.gasHelpUrl(31337), null);
  });
});

describe("buying RUSH", () => {
  it("pre-selects RUSH as the output token on the active chain", () => {
    const url = new URL(chain.uniswapSwapUrl(RUSH, chain.robinhoodChain.id));
    assert.equal(url.searchParams.get("outputCurrency"), RUSH);
    assert.equal(url.searchParams.get("chain"), "4663");
  });
});
