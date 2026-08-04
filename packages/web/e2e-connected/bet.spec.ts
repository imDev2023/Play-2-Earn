import { HARDHAT_CHAIN_ID, expect, test } from "./fixtures/wallet";

/**
 * A real bet, placed and settled.
 *
 * Everything here is real: a real `approve`, a real `placeBet`, real contracts on the
 * local node, and a settlement written by the real relayer. Nothing about the outcome
 * is stubbed, which is the point - the fairness record a player is shown has to come
 * out of the same commit-reveal the verifier checks, and a stubbed settlement would
 * assert the UI against a story the chain never told.
 *
 * Serial, because the game settles one bet at a time. Parallel bet tests would queue
 * behind each other and fail as timeouts that look like product bugs.
 */
test.describe.configure({ mode: "serial" });

test.describe("placing a bet", () => {
  test("settles, and shows a fairness record for the settled roll", async ({ page, wallet }) => {
    await wallet({ chainId: HARDHAT_CHAIN_ID });
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();

    await expect(page.getByTestId("balance")).toBeVisible();
    const before = await page.getByTestId("balance").textContent();

    await page.getByTestId("stake").fill("100");
    await expect(page.getByTestId("place-bet")).toBeEnabled();
    await page.getByTestId("place-bet").click();

    // Wait on the fairness record, not on the button. A bet is settled when the
    // relayer has revealed it, and the record is the first thing that proves it.
    // Waiting for the button to re-enable would be a race: it is enabled before the
    // click too, so the assertion can match the pre-click state and pass having
    // waited for nothing. The approval step is skipped whenever the standing budget
    // still covers the stake, so no intermediate state is safe to wait on either.
    //
    // Win or lose is the chain's business. That a verdict exists at all is ours.
    await expect(page.getByTestId("fairness-verdict")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("fairness-roll")).toBeVisible();
    await expect(page.getByTestId("verify-link")).toBeVisible();
    await expect(page.getByTestId("place-bet")).toBeEnabled();

    // The record has to be checkable independently, which is the whole fairness claim.
    const href = await page.getByTestId("verify-link").getAttribute("href");
    expect(href).toContain("/verify");

    await expect(page.getByTestId("history")).toContainText("100");
    // The stake left the balance either way, so it cannot read as it did before.
    await expect(page.getByTestId("balance")).not.toHaveText(before ?? "");
  });

  test("reports a declined wallet prompt instead of hanging", async ({ page, wallet }) => {
    const handle = await wallet({ chainId: HARDHAT_CHAIN_ID });
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("place-bet")).toBeEnabled();

    await handle.rejectNextTransaction();
    await page.getByTestId("place-bet").click();

    // Deliberately not asserting the exact wording. Whether the raw wallet string
    // "User rejected the request." should reach a player is an open product question,
    // and pinning it here would turn improving that copy into a test failure. What
    // must hold is that a decline surfaces and the button comes back.
    await expect(page.getByTestId("error")).toBeVisible();
    await expect(page.getByTestId("error")).not.toBeEmpty();
    await expect(page.getByTestId("place-bet")).toBeEnabled();
  });
});
