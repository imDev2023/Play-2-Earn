import { test, expect } from "@playwright/test";

test("home page renders the RUSHOOD tagline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RUSHOOD" })).toBeVisible();
  await expect(page.getByTestId("tagline")).toHaveText("Pick your odds.");
});

test("play panel mounts wagmi and offers a wallet connection", async ({ page }) => {
  await page.goto("/");
  // Disconnected state: the panel prompts to connect and renders a connector button.
  // (A live chain isn't available in CI, so we assert the wiring, not an on-chain bet.)
  await expect(page.getByText("Connect a wallet to play.")).toBeVisible();
  await expect(page.getByTestId("connect-mock")).toBeVisible();
});
