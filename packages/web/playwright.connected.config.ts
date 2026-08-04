import { defineConfig, devices } from "@playwright/test";

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
 *
 * The port defaults away from 3000 and 3100 on purpose; both are commonly held by
 * something else, and `reuseExistingServer` trusts whatever answers, so a busy port
 * means silently testing a different app.
 */
const port = Number(process.env.PORT ?? 3210);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e-connected",
  // A settled bet waits on the relayer's poll interval, not on a click.
  timeout: 120_000,
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
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
