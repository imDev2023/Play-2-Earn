import { playwrightConfig } from "./playwright.base";

/**
 * The connected-path E2E harness.
 *
 * Deliberately a second config rather than a project inside the first, because the
 * two suites want opposite worlds. `playwright.config.ts` asserts the disconnected
 * UI and its admin specs assert the chain is *unreachable*, so it needs the Hardhat
 * node stopped. Everything here connects a wallet, reads balances and settles a real
 * bet, so it needs the node running with the skeleton deployed. One config cannot
 * satisfy both, and a project split inside one config would let a single `npx
 * playwright test` run both against whichever world happened to be up - which fails
 * in a way that looks like a product bug rather than a stack that is not ready.
 */
export default playwrightConfig({
  testDir: "./e2e-connected",
  defaultPort: 3210,
  // A settled bet waits on the relayer's poll interval, not on a click.
  timeout: 120_000,
  // Capped, and measured rather than guessed. Every worker holds a browser polling
  // the same single-threaded Hardhat node, so past a handful of them the node is the
  // bottleneck: at Playwright's default (10 here) the bet spec intermittently failed
  // to see its settlement inside 90s, roughly one run in three. At 4 it passed six
  // runs out of six and the whole suite got *faster* - 12.5s against 16s - because
  // the contention was costing more than the parallelism was winning.
  workers: 4,
});
