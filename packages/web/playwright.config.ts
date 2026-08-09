import { playwrightConfig } from "./playwright.base";

/**
 * The disconnected E2E harness. The web server is started by Playwright itself
 * (Next dev server), so `npm test` is self-contained.
 *
 * These specs assert the UI of a browser with no wallet connected, and the admin
 * ones assert the chain is unreachable - so this suite wants the Hardhat node
 * stopped. The connected path lives in `playwright.connected.config.ts`.
 */
export default playwrightConfig({
  testDir: "./e2e",
  defaultPort: 3000,
  // The dev server compiles each route on first request, which can take ~30s cold -
  // longer than a default-timeout test is willing to wait for the first hit on a
  // route the webServer health check didn't warm.
  timeout: 90_000,
});
