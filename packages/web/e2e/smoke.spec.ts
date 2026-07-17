import { test, expect } from "@playwright/test";

test("home page renders the RUSHOOD tagline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RUSHOOD" })).toBeVisible();
  await expect(page.getByTestId("tagline")).toHaveText("Pick your odds.");
});
