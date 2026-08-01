import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readableError, switchFailureMessage } from "../lib/errors";

describe("readableError", () => {
  it("keeps only the first line of a multi-paragraph provider error", () => {
    const error = new Error(
      "The contract function \"setMinBet\" reverted.\n\nError: EconomicsLocked()\n\nVersion: viem@2.55.2",
    );
    assert.equal(readableError(error), 'The contract function "setMinBet" reverted.');
  });

  it("handles a thrown non-Error", () => {
    assert.equal(readableError("user rejected"), "user rejected");
  });
});

/**
 * A failed network switch used to leave the button back at its resting label with no
 * explanation, so the only feedback for an unfixable-by-clicking failure was to click
 * again. These are the messages that replaced that.
 */
describe("switchFailureMessage", () => {
  /**
   * The local-development case, and close to guaranteed: every Hardhat and Anvil preset
   * points at 127.0.0.1:8545, so anyone who has done Ethereum development already has a
   * network saved there under a different chain id. The wallet then refuses to add ours
   * and there is nothing the site can do except say which list to go and edit.
   */
  it("explains an RPC URL already claimed by another network", () => {
    const message = switchFailureMessage(
      new Error(
        "Could not add network that points to same RPC endpoint as existing network for chain 0x539 ('Hardhat Sepolia Fork')",
      ),
    );
    assert.match(String(message), /already has a different network saved against this RPC URL/);
    assert.match(String(message), /network list/);
  });

  it("explains a chain the wallet has never heard of", () => {
    const message = switchFailureMessage(
      new Error('Unrecognized chain ID "0x7a69". Try adding the chain using wallet_addEthereumChain first.'),
    );
    assert.match(String(message), /does not know this network yet/);
  });

  /** Declining a prompt is a decision, not a fault, and must not be shown as one. */
  it("says nothing when the person simply declined", () => {
    assert.equal(switchFailureMessage(new Error("User rejected the request.")), null);
    assert.equal(switchFailureMessage(new Error("MetaMask Tx Signature: User denied")), null);
  });

  it("falls back to the wallet's own first line for anything unrecognised", () => {
    assert.equal(
      switchFailureMessage(new Error("Wallet is locked.\n\nVersion: viem@2.55.2")),
      "Wallet is locked.",
    );
  });
});
