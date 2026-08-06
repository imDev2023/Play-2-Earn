"use client";

import { useEffect, useState } from "react";
import { useConnect } from "wagmi";
import { orderedConnectors } from "./connectors";

/**
 * The wallets the connect button offers, and the call that opens one.
 *
 * Both places that ask anyone to connect - the play page and the admin console - need
 * the same things: which connector to lead with (see lib/connectors), which others to
 * offer instead, whether a legacy `window.ethereum` is present, and whether it is yet
 * safe to say there is no wallet at all. Keeping that in one hook is what stops the two
 * screens drifting into disagreeing about what is installed.
 *
 * `ready` exists because none of those signals arrive on the first render. `window` is
 * absent during the server render, so a component that trusted the first paint would
 * show "no wallet" to somebody who has MetaMask.
 *
 * EIP-6963 is the harder half. Wallets announce themselves asynchronously in response
 * to a `requestProvider` event, and they do not all answer in the same tick. Waiting
 * only on `window` means the button can commit to "Connect Rabby" and swap to "Connect
 * MetaMask" a frame later - the same unstable choice lib/connectors exists to prevent,
 * since a player clicking inside that window opens a different wallet than they did
 * last load. So `ready` waits for the announcements to go quiet instead: the timer
 * below restarts every time the connector list grows, and only once it survives
 * `QUIET_MS` untouched does the hook commit to an answer. Re-asking for providers on
 * mount is what makes that terminate promptly - wagmi asks once when the config is
 * created, and a wallet that injected itself after that would otherwise be missed.
 */

/**
 * How long the connector list must hold still before the choice is committed. Long
 * enough for an extension that answers a fraction of a second late, short enough that
 * nobody reads the resting button as the page being stuck.
 */
const QUIET_MS = 250;

export function useWalletConnector() {
  const { connect, connectors } = useConnect();
  const [ready, setReady] = useState(false);
  const [hasInjectedProvider, setHasInjectedProvider] = useState(false);

  useEffect(() => {
    setHasInjectedProvider(Boolean((window as { ethereum?: unknown }).ethereum));
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }, []);

  // Keyed on the connector count, so a wallet announcing itself restarts the wait
  // rather than landing after the button has already named a different one.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [connectors.length]);

  const ordered = orderedConnectors(connectors, hasInjectedProvider);

  return {
    /** The connector to lead with, or undefined when there is nothing to connect to. */
    wallet: ordered[0],
    /** Other wallets the player could use instead. Empty unless two announced. */
    alternatives: ordered.slice(1),
    /** True once the wallets have been discovered; false while that is still settling. */
    ready,
    /** Opens one of the discovered wallets, defaulting to the one led with. */
    connectWallet: (connector = ordered[0]) => {
      if (connector) connect({ connector });
    },
  };
}
