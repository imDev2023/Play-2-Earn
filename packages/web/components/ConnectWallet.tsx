"use client";

import { connectLabel } from "../lib/connectors";
import { useWalletConnector } from "../lib/useWalletConnector";
import { ghostButton, hint, linkButton } from "../lib/ui";

/**
 * The connect step, wherever it appears.
 *
 * Both screens that ask for a wallet - the play page and the admin console - render
 * this, so they cannot drift into offering different things. They already shared the
 * *decision* (lib/useWalletConnector); before this component they still each spelled
 * out the rendering of it, and had already diverged: one sent a player with no wallet
 * to somewhere they could get one, the other told them the bad news and stopped.
 *
 * Three states, in the order they resolve:
 *
 *   - Discovering. A disabled button, because the answer is milliseconds away and a
 *     browser with a wallet must never flash "no wallet" on its way to finding it.
 *   - A wallet. One button naming it. Naming matters more than it looks: the button is
 *     the last thing read before an extension window nobody opened takes over the
 *     screen, and a button that said "Connect" while MetaMask appeared is a moment of
 *     doubt on the exact screen where the app is asking to be trusted. Any other
 *     installed wallets follow as alternatives, so leading with one is a default and
 *     not a restriction.
 *   - Nothing. A link to somewhere a wallet can be got, rather than a button whose
 *     only possible outcome is an error.
 */
export function ConnectWallet() {
  const { wallet, alternatives, ready, connectWallet } = useWalletConnector();

  if (!ready) {
    return (
      <button data-testid="connect-wallet" style={ghostButton} disabled>
        Looking for a wallet…
      </button>
    );
  }

  if (!wallet) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <span data-testid="no-wallet" style={hint}>
          No EVM wallet detected in this browser.
        </span>
        <a
          data-testid="install-wallet"
          href="https://ethereum.org/en/wallets/find-wallet/"
          target="_blank"
          rel="noreferrer"
          style={linkButton}
        >
          Get an EVM wallet →
        </a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        <button data-testid="connect-wallet" style={ghostButton} onClick={() => connectWallet()}>
          {connectLabel(wallet)}
        </button>
      </div>
      {alternatives.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={hint}>or</span>
          {alternatives.map((other) => (
            <button
              key={other.uid}
              data-testid="connect-alternative"
              style={linkButton}
              onClick={() => connectWallet(other)}
            >
              {other.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
