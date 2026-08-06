import { test, expect } from "@playwright/test";

/**
 * The admin console against no chain - which is exactly the state CI runs in, and a
 * state a real operator can hit (wrong network, dead RPC, contracts not deployed here).
 *
 * What matters at this seam is that the gate fails closed: nothing about the treasury,
 * the parameters or the controls appears until the chain has confirmed the connected
 * account actually holds a role. The authorised path is exercised live against a local
 * stack, where roles and a timelock exist to be read.
 */

test("the console explains itself before asking anyone to connect", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Treasury & operations" })).toBeVisible();
  // The page states the governance model up front - the delay is the player's protection,
  // and the pause deliberately has none.
  await expect(page.getByText("queue through the governance timelock")).toBeVisible();
});

test("an unconnected visitor is asked to sign in, and sees no treasury", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByTestId("admin-gate")).toBeVisible();
  await expect(page.getByText("Operator sign-in")).toBeVisible();
  await expect(page.getByTestId("connect-wallet")).toBeVisible();

  await expect(page.getByTestId("admin-console")).toHaveCount(0);
  await expect(page.getByTestId("treasury-panel")).toHaveCount(0);
  await expect(page.getByTestId("pause-toggle")).toHaveCount(0);
  await expect(page.getByTestId("change-form")).toHaveCount(0);
});

test("connecting a wallet is not itself authorisation - the roles come from chain", async ({
  page,
}) => {
  await page.goto("/admin");
  await page.getByTestId("connect-wallet").click();

  // With no node to read `governance()` from, the console says so rather than opening.
  await expect(page.getByTestId("chain-unreachable")).toBeVisible();
  await expect(page.getByTestId("admin-console")).toHaveCount(0);
  await expect(page.getByTestId("op-submit")).toHaveCount(0);
});

test("the console links back to the game", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("link", { name: "← back to the game" }).click();
  await expect(page.getByRole("heading", { name: "RUSHOOD" })).toBeVisible();
});
