import { test as base, type Page } from "@playwright/test";
import { localNodeUrl } from "../../playwright.base";

/**
 * A wallet for the connected-path suite.
 *
 * Every e2e spec before this one asserted the disconnected UI, because connecting
 * meant driving a browser extension and an extension cannot be driven headlessly or
 * in parallel. That gap is why #41, #42, both bugs in #45 and the admin hole all
 * reached a human instead of a test.
 *
 * The way through is not a wallet extension and not wagmi's mock connector. It is an
 * EIP-1193 provider injected into the page before any app script runs, announced over
 * EIP-6963 exactly as a real wallet announces itself.
 *
 * The distinction from the mock matters, and it is the reason this suite can exist.
 * wagmi's `mock` connector is built from `wagmiConfig.chains`, so it can only ever
 * report a chain the app was configured with - which is precisely why it could not
 * see the #45 wrong-network bug, where the whole failure was a wallet sitting on a
 * chain the config had never heard of. A provider announced over EIP-6963 arrives
 * through wagmi's real injected connector, so `useAccount().chainId` reports whatever
 * `eth_chainId` returns here, including chain 1. The app under test takes the same
 * path it takes for a real wallet, right down to `orderedConnectors` ranking this
 * announcement above the generic `injected()` fallback and the dev mock.
 *
 * Transactions are not signed here. Hardhat unlocks its test accounts, so
 * `eth_sendTransaction` is forwarded to the node and signed there. That keeps this
 * file free of key material and means a bet placed in a test is a real transaction
 * against real contracts, settled by the real relayer.
 *
 * `wallet()` may be called more than once before navigating, and each call announces
 * another wallet. That is what makes the ranking testable: `orderedConnectors` exists
 * to pick the same wallet on every load out of a set whose announcement order is not
 * guaranteed, and a suite that only ever announced one could not tell whether it did.
 */

/** The local Hardhat node - the chain the app expects a wallet to be on. */
export const HARDHAT_CHAIN_ID = 31337;

/** Ethereum mainnet. Somewhere a player can plausibly be, and cannot play from. */
export const ETHEREUM_CHAIN_ID = 1;

/** Hardhat account #1. Holds the RUSH, so this is the player. */
export const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Hardhat account #0. Deployer, governance and guardian, so this is the operator. */
export const OPERATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** An account holding no admin role and no RUSH, for the not-an-operator path. */
export const OUTSIDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

/** The rDNS `orderedConnectors` leads with when it is present. */
export const METAMASK_RDNS = "io.metamask";

export interface WalletOptions {
  /** The account the wallet holds. */
  address: string;
  /** The chain it starts on. Use ETHEREUM_CHAIN_ID to start on the wrong network. */
  chainId: number;
  /** EIP-6963 reverse-DNS id. Drives which name the connect button shows. */
  rdns: string;
  /** Wallet name, as it appears on the button. */
  name: string;
  /** Where `eth_sendTransaction` and every unhandled method are forwarded. */
  nodeUrl: string;
}

const DEFAULTS: WalletOptions = {
  address: PLAYER,
  chainId: HARDHAT_CHAIN_ID,
  rdns: "io.rabby",
  name: "Rabby Wallet",
  // LOCAL_RPC_PORT is the same knob `packages/contracts` uses, so moving the node off
  // a busy 8545 moves this wallet with it. Hardcoded, the wallet kept signing against
  // 8545 while every read followed the relocated node - and the write path failed with
  // an opaque RPC error that looked like an app bug rather than a harness port split.
  //
  // Shared with `localChainEnv`, which builds the app's own transport, rather than
  // spelled out twice: two copies of this expression is how the split came back from
  // the other side, with the wallet following the port and the app left on 8545.
  nodeUrl: localNodeUrl(),
};

/**
 * Controls one injected wallet exposes to a test.
 *
 * The page-side object is synchronous; every method here is the same call reached
 * over `page.evaluate`, so the shape is derived rather than written out twice.
 */
export type WalletHandle = {
  [K in keyof PageWallet]: (
    ...args: Parameters<PageWallet[K]>
  ) => Promise<ReturnType<PageWallet[K]>>;
};

/** The wallet as it exists inside the page. */
interface PageWallet {
  /** Move the wallet to another chain, as a player switching network in their wallet. */
  setChain(chainId: number): void;
  /** What chain the wallet is on right now. */
  chainId(): number;
  /** Make the next `eth_sendTransaction` fail the way a declined prompt fails. */
  rejectNextTransaction(): void;
}

/**
 * Install a provider. Runs as an init script, so it is in place before the app's
 * first script and before wagmi's EIP-6963 discovery starts listening.
 */
async function installWallet(page: Page, opts: WalletOptions): Promise<void> {
  await page.addInitScript((opts: WalletOptions) => {
    let chainId = `0x${opts.chainId.toString(16)}`;
    let authorized = false;
    let rejectNext = false;

    const listeners: Record<string, ((payload: unknown) => void)[]> = {};
    const emit = (event: string, payload: unknown) =>
      (listeners[event] ?? []).forEach((fn) => fn(payload));

    let rpcId = 1000;
    async function toNode(method: string, params: unknown[]): Promise<unknown> {
      const res = await fetch(opts.nodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.error.message), json.error);
      return json.result;
    }

    const provider = {
      async request({ method, params = [] }: { method: string; params?: unknown[] }) {
        switch (method) {
          case "eth_chainId":
            return chainId;

          case "net_version":
            return String(parseInt(chainId, 16));

          // Before the player has approved the connection, a wallet reports no
          // accounts. Reporting one here would connect the app on load and there
          // would be no connect button left to assert on.
          case "eth_accounts":
            return authorized ? [opts.address] : [];

          case "eth_requestAccounts":
            authorized = true;
            emit("accountsChanged", [opts.address]);
            return [opts.address];

          case "wallet_requestPermissions":
            authorized = true;
            return [{ parentCapability: "eth_accounts" }];

          case "wallet_switchEthereumChain": {
            const next = (params[0] as { chainId: string }).chainId;
            chainId = next;
            // Asynchronously, and this is not incidental. wagmi arms its
            // `chainChanged` listener and issues this request together; emitting
            // inside the call resolves the event before anything is listening for
            // it, and the switch appears to do nothing at all.
            setTimeout(() => emit("chainChanged", next), 0);
            return null;
          }

          case "wallet_addEthereumChain":
            return null;

          case "eth_sendTransaction":
            if (rejectNext) {
              rejectNext = false;
              // Shape matters: 4001 with this message is what wagmi turns into a
              // UserRejectedRequestError, which is the path the UI copy sits on.
              throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            }
            return toNode(method, params);

          default:
            return toNode(method, params);
        }
      },
      on(event: string, handler: (payload: unknown) => void) {
        (listeners[event] ??= []).push(handler);
      },
      removeListener(event: string, handler: (payload: unknown) => void) {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== handler);
      },
    };

    const registry = ((window as unknown as { __wallets?: Record<string, unknown> }).__wallets ??=
      {});
    registry[opts.rdns] = {
      setChain(next: number) {
        chainId = `0x${next.toString(16)}`;
        emit("chainChanged", chainId);
      },
      chainId: () => parseInt(chainId, 16),
      rejectNextTransaction() {
        rejectNext = true;
      },
    };

    // The legacy pre-EIP-6963 handle. Only the first wallet to announce takes it, so
    // a second wallet does not silently become the one `injected()` reaches.
    (window as unknown as { ethereum?: unknown }).ethereum ??= provider;

    const detail = Object.freeze({
      info: {
        // Stable per wallet, distinct between wallets. wagmi keys announced
        // connectors by uuid, so a shared one would collapse two wallets into one.
        uuid: `00000000-0000-4000-8000-${opts.rdns
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 12)
          .padEnd(12, "0")}`,
        name: opts.name,
        rdns: opts.rdns,
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      },
      provider,
    });

    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));

    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, opts);
}

export interface WalletFixtures {
  /**
   * Announce a wallet to the page. Call before navigating - it registers an init
   * script, which only applies to loads that come after it. Call more than once to
   * announce more than one wallet.
   */
  wallet: (options?: Partial<WalletOptions>) => Promise<WalletHandle>;
}

export const test = base.extend<WalletFixtures>({
  wallet: async ({ page }, use) => {
    await use(async (overrides = {}) => {
      const opts = { ...DEFAULTS, ...overrides };
      await installWallet(page, opts);

      // Keyed by rdns, so each handle drives the wallet it was created for even when
      // the page has several announced.
      const { rdns } = opts;
      return {
        setChain: (chainId: number) =>
          page.evaluate(([id, next]) => window.__wallets[id].setChain(next), [
            rdns,
            chainId,
          ] as const),
        chainId: () => page.evaluate((id) => window.__wallets[id].chainId(), rdns),
        rejectNextTransaction: () =>
          page.evaluate((id) => window.__wallets[id].rejectNextTransaction(), rdns),
      };
    });
  },
});

/**
 * Announce a wallet, open a page and connect it.
 *
 * Every spec in this suite starts this way, and spelling it out at each one buried
 * what the test was actually about under three lines of setup.
 */
export async function connectAs(
  page: Page,
  wallet: WalletFixtures["wallet"],
  options: Partial<WalletOptions> & { path?: string } = {},
): Promise<WalletHandle> {
  const { path = "/", ...walletOptions } = options;
  const handle = await wallet(walletOptions);
  await page.goto(path);
  await page.getByTestId("connect-wallet").click();
  return handle;
}

export { expect } from "@playwright/test";

declare global {
  interface Window {
    /** Every announced wallet, by rDNS. Installed by the init script above. */
    __wallets: Record<string, PageWallet>;
  }
}
