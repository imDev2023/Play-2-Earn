import { defineConfig, devices } from "@playwright/test";

/** Only the keys these helpers read, so a test can pass a literal without a full env. */
type Env = Record<string, string | undefined>;

/**
 * Where the local Hardhat node is, for everything in the harness that has to reach it.
 *
 * One definition on purpose. The wallet fixture used to carry its own copy of this
 * expression and the app carried none, so `LOCAL_RPC_PORT` moved the node and the
 * fixture together while every read the app made stayed on 8545 - writes landing on one
 * node and reads answered by whatever held the other, which surfaces as an opaque RPC
 * error and reads as a bug in the app. Both now import this.
 *
 * An empty value counts as unset, matching the `node` script's `${LOCAL_RPC_PORT:-8545}`,
 * which cannot tell empty from absent either.
 */
export function localNodeUrl(env: Env = process.env): string {
  return `http://127.0.0.1:${env.LOCAL_RPC_PORT?.trim() || "8545"}`;
}

/**
 * The chain identity both E2E suites are written against, as environment the app is
 * built with rather than environment it happens to inherit.
 *
 * Next inlines `NEXT_PUBLIC_*` at compile time and fills any the shell has not set
 * from `packages/web/.env`, which is gitignored and on a working machine points
 * wherever that developer last pointed it. Without this, a `.env` naming the testnet
 * silently retargets both suites: the connected specs fail as "Switch network to
 * play", and the disconnected admin specs fail because the chain they assert is
 * unreachable answers on the first try. CI has no `.env`, so none of it reproduces
 * there - green in CI and red on the machine of whoever runs it is the worst shape a
 * suite can have, because the suite looks like the thing that is wrong.
 *
 * The transport comes from `localNodeUrl` above, so the app and the wallet fixture
 * cannot end up pointed at different nodes.
 *
 * The addresses are blanked rather than named: `lib/addresses.ts` treats "" as unset,
 * so both resolve to the committed 31337 skeleton entry instead of a `.env` override
 * pointing at contracts on some other chain.
 *
 * Taken as an argument the way `localRpcUrl` takes one in `packages/contracts`, so
 * the mapping can be asserted without a test having to mutate `process.env`.
 */
export function localChainEnv(env: Env = process.env): Record<string, string> {
  return {
    NEXT_PUBLIC_CHAIN_ID: "31337",
    NEXT_PUBLIC_RPC_URL: env.NEXT_PUBLIC_RPC_URL?.trim() || localNodeUrl(env),
    NEXT_PUBLIC_GAME_ADDRESS: "",
    NEXT_PUBLIC_RUSH_ADDRESS: "",
  };
}

/**
 * What the two E2E harnesses share.
 *
 * They are separate configs on purpose - see `playwright.connected.config.ts` for
 * why - but everything below is the same in both, and the part that matters most is
 * the port handling. `reuseExistingServer` trusts whatever already answers on the
 * port, so if an unrelated process holds it the whole suite silently runs against
 * the wrong app - and that includes a `next dev` this repo started itself with other
 * environment, because two dev servers run from `packages/web` share `.next` and the
 * later build's inlined `NEXT_PUBLIC_*` values overwrite the earlier one's chunks.
 * `env` below fixes what a server *this config* starts is built with; it cannot fix
 * one that is already running, so stop a stray dev server rather than trusting the
 * port. That reasoning only has to be got right once.
 */
export function playwrightConfig({
  testDir,
  defaultPort,
  timeout,
  workers,
}: {
  testDir: string;
  /** Overridable with PORT. Kept away from 3000 and 3100, which are commonly taken. */
  defaultPort: number;
  timeout: number;
  /** Left to Playwright's default unless a suite has a reason to cap it. */
  workers?: number;
}) {
  const port = Number(process.env.PORT ?? defaultPort);
  const baseURL = `http://localhost:${port}`;

  return defineConfig({
    testDir,
    timeout,
    workers,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: "list",
    use: {
      baseURL,
      trace: "on-first-retry",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
      command: `npm run dev -- --port ${port}`,
      url: baseURL,
      env: localChainEnv(),
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  });
}
