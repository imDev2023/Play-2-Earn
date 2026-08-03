/**
 * Which wallet the single "Connect" button opens.
 *
 * wagmi hands the app more connectors than a player should ever be asked to choose
 * between. There is the built-in `injected()` fallback, one EIP-6963 entry for every
 * browser wallet that announces itself, and - in local development - a mock signing as
 * a hard-coded Hardhat account. Rendering a button per connector meant anyone with
 * MetaMask installed was shown three: "Connect Injected", "Connect Mock Connector" and
 * "Connect MetaMask". Two of those reach the same extension, and the third logs in as
 * somebody else's test key. The choice carried no information a player could act on.
 *
 * So the app ranks them, and leads with one. The order below is a preference, not a
 * ranking of wallets: it exists to make the button land on the same wallet every time.
 *
 *   1. MetaMask, when installed. Not favouritism - EIP-6963 announcement order is not
 *      guaranteed, so with several wallets installed an "first one wins" rule would
 *      open a different wallet after a refresh. Naming one keeps it predictable, and
 *      MetaMask is the wallet the onboarding copy and the docs already assume.
 *   2. Any other announced wallet, alphabetically, for the same stability reason.
 *   3. The generic injected entry, but only when a provider is actually present and no
 *      wallet announced itself. `injected()` sits in the list whether or not a wallet
 *      exists, so on a browser with none it is a button whose only possible outcome is
 *      an error - and where a wallet did announce, it is a second button onto the same
 *      extension, which is half of what put three buttons on the page.
 *   4. The dev mock, last and only when nothing real is available, so it can never win
 *      from a wallet somebody actually installed.
 *
 * Everything after the first entry is an alternative, offered but not led with, so a
 * player who keeps two wallets and prefers the other one is not stuck: the spec asks
 * for "connectors (MetaMask etc.)", not for MetaMask alone. Only announced wallets can
 * ever appear there - the fallbacks are mutually exclusive with them by construction.
 *
 * Nothing here reaches for `window`; the caller passes what it observed. That keeps the
 * decision testable and keeps it out of the server render, where `window.ethereum`
 * does not exist and guessing at it would cause a hydration mismatch.
 */

/** The parts of a wagmi connector this decision needs. */
export interface WalletConnector {
  /** EIP-6963 reverse-DNS name for announced wallets, else the connector's own id. */
  id: string;
  name: string;
  type: string;
}

/** The id wagmi gives its built-in `injected()` fallback connector. */
export const GENERIC_INJECTED_ID = "injected";

/** MetaMask's EIP-6963 reverse-DNS identifier. */
const METAMASK_RDNS = "io.metamask";

/** wagmi's type tag for injected wallets - both announced ones and the fallback. */
const INJECTED_TYPE = "injected";

/** wagmi's type tag for the dev-only mock connector. */
const MOCK_TYPE = "mock";

/**
 * Every connector worth offering, best first.
 *
 * `hasInjectedProvider` is whether the page actually has a legacy `window.ethereum`.
 */
export function orderedConnectors<T extends WalletConnector>(
  connectors: readonly T[],
  hasInjectedProvider: boolean,
): T[] {
  const announced = connectors
    .filter((c) => c.type === INJECTED_TYPE && c.id !== GENERIC_INJECTED_ID)
    .sort((a, b) => a.name.localeCompare(b.name));

  const metaMask = announced.find((c) => c.id === METAMASK_RDNS);
  if (metaMask) return [metaMask, ...announced.filter((c) => c !== metaMask)];
  if (announced.length > 0) return announced;

  if (hasInjectedProvider) {
    const generic = connectors.find((c) => c.id === GENERIC_INJECTED_ID);
    if (generic) return [generic];
  }

  const dev = connectors.find((c) => c.type === MOCK_TYPE);
  return dev ? [dev] : [];
}

/** The one connector to lead with, or undefined when there is no wallet to connect to. */
export function chooseConnector<T extends WalletConnector>(
  connectors: readonly T[],
  hasInjectedProvider: boolean,
): T | undefined {
  return orderedConnectors(connectors, hasInjectedProvider)[0];
}

/**
 * What the button says.
 *
 * Naming the wallet matters more than it looks: the button is the last thing a player
 * reads before an extension window they did not open takes over the screen, and a
 * button that said "Connect" while MetaMask opened is a moment of doubt on the exact
 * screen where the app is asking to be trusted.
 */
export function connectLabel(connector: WalletConnector): string {
  if (connector.type === MOCK_TYPE) return "Connect test wallet";
  if (connector.id === GENERIC_INJECTED_ID) return "Connect wallet";
  return `Connect ${connector.name}`;
}
