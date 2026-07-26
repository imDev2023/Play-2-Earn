import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ACTIVE_CHAIN_ID,
  CHAINS,
  MAINNET_ENDPOINTS_CONFIGURED,
  activeChainConfigError,
  chainLabel,
  gasHelpUrl,
  robinhoodChain,
  robinhoodTestnet,
  uniswapSwapUrl,
} from "../lib/chain";

/**
 * Chain configuration (#26).
 *
 * The point of these is the mainnet story: Robinhood Chain's mainnet endpoints are not
 * published, so the app must have *no* guessed URLs baked in and must say so plainly
 * rather than failing as an opaque network error. Testnet endpoints are real and stay
 * asserted so a future edit can't quietly break the working chain either.
 */

const RUSH = "0x1111111111111111111111111111111111111111" as const;

describe("mainnet is not silently mis-configured", () => {
  it("ships no hard-coded mainnet RPC", () => {
    assert.equal(robinhoodChain.rpcUrls.default.http[0], "");
  });

  it("ships no hard-coded mainnet explorer", () => {
    assert.equal(robinhoodChain.blockExplorers?.default.url, "");
  });

  it("reports mainnet as unconfigured in a default build", () => {
    assert.equal(MAINNET_ENDPOINTS_CONFIGURED, false);
  });

  it("explains the problem when the app targets mainnet without endpoints", () => {
    const error = activeChainConfigError(robinhoodChain.id);
    assert.ok(error, "expected a configuration error for mainnet");
    assert.match(error, /NEXT_PUBLIC_ROBINHOOD_RPC_URL/);
    assert.match(error, /4663/);
  });

  it("offers no dead gas link on an unconfigured mainnet", () => {
    assert.equal(gasHelpUrl(robinhoodChain.id), null);
  });
});

describe("testnet stays fully configured", () => {
  it("keeps a real RPC endpoint", () => {
    assert.match(robinhoodTestnet.rpcUrls.default.http[0], /^https:\/\/rpc\.testnet\./);
  });

  it("keeps a real explorer", () => {
    assert.match(robinhoodTestnet.blockExplorers?.default.url ?? "", /^https:\/\/explorer\.testnet\./);
  });

  it("points a gasless player at the faucet", () => {
    const url = gasHelpUrl(robinhoodTestnet.id);
    assert.ok(url);
    assert.match(url, /faucet\.testnet\.chain\.robinhood\.com/);
  });

  it("raises no configuration error", () => {
    assert.equal(activeChainConfigError(robinhoodTestnet.id), null);
  });
});

describe("chain metadata", () => {
  it("defaults to the local hardhat chain so dev works out of the box", () => {
    assert.equal(ACTIVE_CHAIN_ID, 31337);
  });

  it("knows all three chains", () => {
    assert.deepEqual(
      CHAINS.map((c) => c.id).sort((a, b) => a - b),
      [4663, 31337, 46630],
    );
  });

  it("labels a known chain by name and an unknown one by id", () => {
    assert.equal(chainLabel(46630), "Robinhood Chain Testnet");
    assert.equal(chainLabel(999999), "Chain 999999");
  });

  it("has nowhere to send a local player for gas", () => {
    assert.equal(gasHelpUrl(31337), null);
  });
});

describe("buying RUSH", () => {
  it("pre-selects RUSH as the output token on the active chain", () => {
    const url = new URL(uniswapSwapUrl(RUSH, robinhoodChain.id));
    assert.equal(url.searchParams.get("outputCurrency"), RUSH);
    assert.equal(url.searchParams.get("chain"), "4663");
  });
});
