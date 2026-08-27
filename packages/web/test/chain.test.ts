import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

/**
 * Chain configuration (#26).
 *
 * The point of these used to be that Robinhood Chain's mainnet endpoints were not
 * published, so the app had to carry *no* guessed URLs and say so plainly rather than
 * failing as an opaque network error. They were published on 2026-07-31, so what these
 * now hold is the pair of facts that replaced it: the endpoints are the real published
 * ones, and mainnet is still unreachable because nothing is deployed there. Those are
 * separate claims, and the second is the one that keeps a mainnet build from happening.
 *
 * Testnet endpoints stay asserted so a future edit can't quietly break the one chain
 * that does have a deployment.
 *
 * lib/chain reads process.env once, at module load, so the environment is cleared
 * *before* it is imported. Without that these assertions would pass or fail depending
 * on whoever's shell was running them - and the whole point is to prove the defaults
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
let addresses: typeof import("../lib/addresses");

before(async () => {
  for (const key of OVERRIDES) delete process.env[key];
  chain = await import("../lib/chain");
  // Loaded after the same clearing, and for the same reason: it resolves the active
  // chain's addresses at module load, so an inherited NEXT_PUBLIC_CHAIN_ID would decide
  // whether importing it throws.
  addresses = await import("../lib/addresses");
});

const RUSH = "0x1111111111111111111111111111111111111111" as const;

/**
 * Mainnet endpoints were withheld under #26 because Robinhood Chain had not published
 * them, and a guessed RPC is worse than a missing one: the app looks configured, points
 * at a hostname nobody controls, and fails at request time as a network error rather
 * than as anything diagnosable.
 *
 * They were published on 2026-07-31 and confirmed live again on 2026-08-27 - chain id
 * 0x1237 off `rpc.mainnet.chain.robinhood.com`, explorer answering 200 - so the
 * reasoning stopped reaching them and the comment claiming they were unpublished had
 * been false for a month. `packages/contracts/hardhat.config.ts` had already committed
 * the same explorer as its default, so the two halves of the repo disagreed in writing.
 *
 * What has not changed is the bridge, which the chain documents only as "the canonical
 * Arbitrum bridge" with no single URL to commit. It stays env-only and `gasHelpUrl`
 * still returns null rather than a guess: the original reasoning, still load-bearing on
 * the one endpoint it still applies to.
 */
describe("mainnet endpoints are the published ones", () => {
  /**
   * The bare host, which is the form the chain documents and the form `docs/ops/relayer.md`,
   * `resources/01-robinhood-chain.md` and the 4663 profile all print. The testnet entry
   * below keeps its `/rpc` suffix: both forms answer, and that one has settled a real bet.
   */
  it("ships the published mainnet RPC, in the form the rest of the repo prints", () => {
    assert.equal(
      chain.robinhoodChain.rpcUrls.default.http[0],
      "https://rpc.mainnet.chain.robinhood.com",
    );
  });

  it("ships the explorer the contracts package already defaults to", () => {
    assert.equal(
      chain.robinhoodChain.blockExplorers?.default.url,
      "https://robinhoodchain.blockscout.com",
    );
  });

  it("raises no endpoint error now that the endpoints exist", () => {
    assert.equal(chain.activeChainConfigError(chain.robinhoodChain.id), null);
  });

  /**
   * "" is how a shell suppresses a value that would otherwise come from a file, so a
   * blanked endpoint is a state an operator can reach - and the message has to survive
   * for them. Asserted through the pure form rather than by re-importing the module
   * with a mutated environment, which would make this test depend on load order.
   */
  it("still explains itself if someone blanks the endpoints", () => {
    const error = chain.mainnetEndpointError({ rpc: "", explorer: "" });
    assert.ok(error, "expected a configuration error for blanked mainnet endpoints");
    assert.match(error, /NEXT_PUBLIC_ROBINHOOD_RPC_URL/);
    assert.match(error, /4663/);
  });

  it("offers no gas link, because the bridge is still not a published constant", () => {
    assert.equal(chain.gasHelpUrl(chain.robinhoodChain.id), null);
  });
});

/**
 * The endpoints being real does not make mainnet reachable, and this is what keeps
 * those two facts apart.
 *
 * Configuring them removed the loudest "this build is not ready for 4663" signal the
 * app had, so the one that remains has to be asserted rather than assumed. It is the
 * stricter of the two anyway: the address book throws at module load, which for a Next
 * build is build time, so the wrong artefact is never produced at all - where the
 * message it replaces only appeared once a player had already loaded the page.
 */
describe("mainnet is still unreachable, because nothing is deployed there", () => {
  it("refuses to resolve contract addresses for 4663", () => {
    assert.throws(
      () => addresses.resolveContractAddresses(chain.robinhoodChain.id, {}),
      /chain 4663 has no committed entry/,
    );
  });

  it("resolves the chains that do have a deployment", () => {
    assert.ok(addresses.resolveContractAddresses(chain.robinhoodTestnet.id, {}).game);
    assert.ok(addresses.resolveContractAddresses(31337, {}).game);
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

  it("treats any chain that is not the active one as wrong", () => {
    // Ethereum is the one that mattered: wallets sit there by default, and the guard
    // used to read a wagmi hook that could never report it.
    assert.equal(chain.isWrongNetwork(1), true);
    assert.equal(chain.isWrongNetwork(4663), true);
    assert.equal(chain.isWrongNetwork(chain.ACTIVE_CHAIN_ID), false);
  });

  it("does not call a wallet that has not reported a chain yet wrong", () => {
    assert.equal(chain.isWrongNetwork(undefined), false);
  });

  it("names the chains players arrive on by mistake", () => {
    // The wrong-network banner reads "You're on {label}". Ethereum is where a wallet
    // sits by default, so it is the label most players will ever see, and "Chain 1"
    // does not tell someone staring at a MetaMask that says "Ethereum" that the two
    // are the same place.
    assert.equal(chain.chainLabel(1), "Ethereum");
    assert.equal(chain.chainLabel(8453), "Base");
    assert.equal(chain.chainLabel(42161), "Arbitrum One");
  });

  it("takes the names of its own chains from their definitions", () => {
    // One table covers both kinds of chain, and the entries for the chains RUSHOOD runs
    // on are derived rather than retyped, so a renamed chain cannot end up with the
    // banner and the rest of the app calling it two different things.
    for (const c of chain.CHAINS) {
      assert.equal(chain.chainLabel(c.id), c.name);
    }
  });

  it("resolves the active chain id to one the app is configured for", () => {
    // Writes name this id so a wallet cannot sign somewhere else. An id the app was
    // never configured with has to be resolved here, not passed to wagmi.
    assert.equal(
      chain.CHAINS.some((c) => c.id === chain.activeChainId),
      true,
    );
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
