import { test, expect } from "@playwright/test";

// A live chain isn't available in CI, so these assert the disconnected experience
// and the on-chain wiring - the full connect → buy → bet → reveal → history flow is
// exercised live against a local node (agent-browser), not here.

test("hero states the pitch: pick your odds, up to 950x", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RUSHOOD" })).toBeVisible();
  await expect(page.getByTestId("tagline")).toContainText("Pick your odds.");
  await expect(page.getByTestId("tagline")).toContainText("950×");
});

test("disconnected state prompts a wallet connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Get in the game")).toBeVisible();
  await expect(page.getByTestId("connect-mock")).toBeVisible();
});

test("the odds ladder features the moonshot at the top and the coin flip at the base", async ({
  page,
}) => {
  await page.goto("/");
  const moonshot = page.getByTestId("rung-5");
  await expect(moonshot).toContainText("Moonshot");
  await expect(moonshot).toContainText("950×");
  await expect(moonshot).toContainText("1-in-1000");

  const coinflip = page.getByTestId("rung-0");
  await expect(coinflip).toContainText("Coin flip");
  await expect(coinflip).toContainText("1.9×");

  // The ladder renders top-down: the moonshot rung sits above the coin flip.
  const moonshotBox = await moonshot.boundingBox();
  const coinflipBox = await coinflip.boundingBox();
  expect(moonshotBox!.y).toBeLessThan(coinflipBox!.y);
});
