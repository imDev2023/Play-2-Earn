"use client";

import { useEffect, useState } from "react";
import { useConnect } from "wagmi";
import { chooseConnector } from "./connectors";

/**
 * The one wallet the connect button offers, and the call that opens it.
 *
 * Both places that ask anyone to connect - the play page and the admin console - need
 * the same three things: which connector to use (see lib/connectors), whether a legacy
 * `window.ethereum` is present, and whether it is yet safe to say there is no wallet
 * at all. Keeping that in one hook is what stops the two screens drifting into
 * disagreeing about what is installed.
 *
 * `ready` exists because both of the signals this depends on arrive after the first
 * render. `window` is absent during the server render, and EIP-6963 wallets announce
 * themselves asynchronously, so a component that trusted the first paint would show
 * "no wallet" to somebody who has MetaMask and then swap it for a connect button a
 * frame later. Callers show a resting state until `ready`, and only then commit to
 * saying a browser has nothing to connect with.
 */
export function useWalletConnector() {
  const { connect, connectors } = useConnect();
  const [ready, setReady] = useState(false);
  const [hasInjectedProvider, setHasInjectedProvider] = useState(false);

  useEffect(() => {
    setHasInjectedProvider(Boolean((window as { ethereum?: unknown }).ethereum));
    setReady(true);
  }, []);

  const wallet = chooseConnector(connectors, { hasInjectedProvider });

  return {
    /** The connector to offer, or undefined when there is nothing to connect to. */
    wallet,
    /** True once the browser has been inspected; false on the first render. */
    ready,
    /** Opens the chosen wallet. A no-op when there is none. */
    connectWallet: () => {
      if (wallet) connect({ connector: wallet });
    },
  };
}
