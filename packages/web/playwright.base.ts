import { defineConfig, devices } from "@playwright/test";

/**
 * What the two E2E harnesses share.
 *
 * They are separate configs on purpose - see `playwright.connected.config.ts` for
 * why - but everything below is the same in both, and the part that matters most is
 * the port handling. `reuseExistingServer` trusts whatever already answers on the
 * port, so if an unrelated process holds it the whole suite silently runs against
 * the wrong app. That reasoning only has to be got right once.
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
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  });
}
