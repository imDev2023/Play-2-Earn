import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  chooseConnector,
  connectLabel,
  orderedConnectors,
  type WalletConnector,
} from "../lib/connectors";

/**
 * Which wallet the one connect button uses.
 *
 * The shapes here are the ones wagmi actually hands the app. An EIP-6963 wallet is an
 * `injected` connector whose id is the wallet's reverse-DNS name; the built-in
 * `injected()` fallback is an `injected` connector whose id is the literal string
 * "injected". Telling those two apart is the whole job, because when both are present
 * they connect to the same wallet and a player offered both learns nothing from the
 * choice.
 */

const metaMask: WalletConnector = { id: "io.metamask", name: "MetaMask", type: "injected" };
const rabby: WalletConnector = { id: "io.rabby", name: "Rabby", type: "injected" };
const coinbase: WalletConnector = { id: "com.coinbase.wallet", name: "Coinbase Wallet", type: "injected" };
const generic: WalletConnector = { id: "injected", name: "Injected", type: "injected" };
const dev: WalletConnector = { id: "mock", name: "Mock Connector", type: "mock" };

const WITH_PROVIDER = true;
const WITHOUT_PROVIDER = false;

describe("chooseConnector", () => {
  it("prefers a discovered wallet over the generic injected entry for the same wallet", () => {
    // The exact case that put three buttons on the page: MetaMask announces itself
    // over EIP-6963 *and* satisfies `injected()`, so both entries reach the same
    // extension.
    assert.equal(chooseConnector([generic, dev, metaMask], WITH_PROVIDER), metaMask);
  });

  it("picks MetaMask when several wallets are installed, so the choice is stable", () => {
    // Announcement order is not guaranteed between page loads. Without a rule, the
    // single button would connect to a different wallet on a refresh.
    assert.equal(chooseConnector([rabby, metaMask, coinbase, generic], WITH_PROVIDER), metaMask);
  });

  it("falls back to the alphabetically first wallet when MetaMask is absent", () => {
    assert.equal(chooseConnector([rabby, coinbase, generic], WITH_PROVIDER), coinbase);
  });

  it("uses the generic injected entry for a wallet that does not announce itself", () => {
    // Wallets predating EIP-6963 only set window.ethereum. They are still playable.
    assert.equal(chooseConnector([generic, dev], WITH_PROVIDER), generic);
  });

  it("ignores the generic injected entry when no wallet actually injected a provider", () => {
    // `injected()` is always in the list whether or not a wallet exists. Offering it
    // on a browser with no wallet is a button whose only outcome is an error, and in
    // local dev it would hide the test wallet that makes the app playable at all.
    assert.equal(chooseConnector([generic, dev], WITHOUT_PROVIDER), dev);
  });

  it("never prefers the test wallet over a real one", () => {
    // The mock signs as a hard-coded Hardhat account. It is a last resort, never a
    // default anyone with a real wallet could land on.
    assert.equal(chooseConnector([dev, metaMask], WITH_PROVIDER), metaMask);
    assert.equal(chooseConnector([dev, generic], WITH_PROVIDER), generic);
  });

  it("returns nothing when there is no wallet and no test connector", () => {
    // A production build registers no mock, so a player with no wallet gets the
    // install prompt rather than a button that cannot work.
    assert.equal(chooseConnector([generic], WITHOUT_PROVIDER), undefined);
    assert.equal(chooseConnector([], WITH_PROVIDER), undefined);
  });
});

describe("connectLabel", () => {
  it("names the wallet it will open, so the button matches the prompt that appears", () => {
    assert.equal(connectLabel(metaMask), "Connect MetaMask");
    assert.equal(connectLabel(coinbase), "Connect Coinbase Wallet");
  });

  it("stays generic for an unnamed injected wallet", () => {
    assert.equal(connectLabel(generic), "Connect wallet");
  });

  it("says plainly that the test wallet is not a real one", () => {
    assert.equal(connectLabel(dev), "Connect test wallet");
  });
});

describe("orderedConnectors", () => {
  it("offers the other installed wallets after the one it leads with", () => {
    // Leading with MetaMask is a default, not a restriction: the spec asks for
    // "connectors (MetaMask etc.)", and somebody who keeps two wallets and prefers the
    // other one needs a way through that is not uninstalling it.
    const ordered = orderedConnectors([rabby, metaMask, coinbase, generic], WITH_PROVIDER);
    assert.deepEqual(
      ordered.map((c) => c.name),
      ["MetaMask", "Coinbase Wallet", "Rabby"],
    );
  });

  it("never offers a second route to the same wallet", () => {
    // The generic injected entry reaches whatever announced itself, so listing it as an
    // alternative would set "Injected" beside "MetaMask" and make them look like a
    // choice. That was half of the three-button bug.
    assert.deepEqual(orderedConnectors([generic, dev, metaMask], WITH_PROVIDER), [metaMask]);
  });

  it("offers the test wallet alone, never beside a real one", () => {
    assert.deepEqual(orderedConnectors([generic, dev], WITHOUT_PROVIDER), [dev]);
    assert.deepEqual(orderedConnectors([dev, metaMask], WITH_PROVIDER), [metaMask]);
  });

  it("is empty when there is nothing to connect to", () => {
    assert.deepEqual(orderedConnectors([generic], WITHOUT_PROVIDER), []);
  });
});
