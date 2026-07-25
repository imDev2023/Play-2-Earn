import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E harness. The web server is started by Playwright itself
 * (Next dev server), so `npm test` is self-contained.
 *
 * The port is overridable because `reuseExistingServer` trusts whatever already
 * answers on it — if an unrelated process holds 3000, the whole suite silently runs
 * against the wrong app. `PORT=3100 npm test` sidesteps that.
 */
const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // The dev server compiles each route on first request, which can take ~30s cold —
  // longer than a default-timeout test is willing to wait for the first hit on a
  // route the webServer health check didn't warm.
  timeout: 90_000,
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
