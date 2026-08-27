import { connectAs, expect, test } from "./fixtures/wallet";

/**
 * A real bet, placed and settled.
 *
 * Everything here is real: a real `approve`, a real `placeBet`, real contracts on the
 * local node, and a settlement written by the real relayer. Nothing about the outcome
 * is stubbed, which is the point - the fairness record a player is shown has to come
 * out of the same commit-reveal the verifier checks, and a stubbed settlement would
 * assert the UI against a story the chain never told.
 *
 * Serial, because the game settles one bet at a time and the bets here are all placed
 * by the same account - the one holding the RUSH. Parallel bet tests would queue
 * behind each other and fail as timeouts that look like product bugs. This holds for
 * a normal run and for retries, which Playwright runs one after another; it does not
 * hold under `--repeat-each`, which schedules the copies concurrently and will make
 * this file fail on chain contention rather than on anything about the app.
 */
test.describe.configure({ mode: "serial" });

/** Every settled play in the history list, newest first. */
const historyRows = '[data-testid^="history-"]:not([data-testid="history-empty"])';

test.describe("placing a bet", () => {
  test("settles, and shows a fairness record for the settled roll", async ({ page, wallet }) => {
    await connectAs(page, wallet);

    await expect(page.getByTestId("balance")).toBeVisible();
    const before = await page.getByTestId("balance").textContent();
    expect(
      before,
      "the balance has to be readable for the comparison below to mean anything",
    ).not.toBeNull();

    // The chain is not reset between runs or between retries, so "a settled bet
    // exists" is true before this test does anything. Counting the plays first and
    // requiring one more is what makes the assertion about *this* bet: without it a
    // retry passes on the previous attempt's already-revealed bet, and the test would
    // go green having settled nothing.
    const playsBefore = await page.locator(historyRows).count();

    await page.getByTestId("stake").fill("100");
    await expect(page.getByTestId("place-bet")).toBeEnabled();
    await page.getByTestId("place-bet").click();

    // Two signals, and both are needed.
    //
    // The verdict is the settled one: FairnessPanel renders it from `history[0]` only
    // once that bet has been revealed, so a bet still in flight shows nothing. But on
    // its own it would pass on a *previous* bet, because the chain is not reset
    // between runs or retries and row 0 is already settled when the page loads.
    //
    // The count is what makes it this bet. Strictly greater rather than exactly one
    // more: the history belongs to the account, so anything else betting as the same
    // player counts too, and pinning an exact number would fail on a collision rather
    // than on a defect.
    //
    // Waiting on the button instead would be a race - it is enabled before the click
    // too, so the assertion could match the pre-click state and pass having waited for
    // nothing. The approval step is skipped whenever the standing budget still covers
    // the stake, so no intermediate state is safe to wait on either.
    await expect(page.getByTestId("fairness-verdict")).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(() => page.locator(historyRows).count(), { timeout: 90_000 })
      .toBeGreaterThan(playsBefore);

    await expect(page.getByTestId("fairness-roll")).toBeVisible();

    // The reveal has to land on the number the draw promised, and for a miss it used to
    // land on a bare `-`. Both expectations below are exact because this bet is at the
    // default tier, the coin flip: a win pays 100 x 0.95 x 2, and the only losing roll of
    // a 1-in-2 draw is 1. Exactness is what makes this an assertion about the number
    // rather than about one merely being present.
    //
    // The phase is waited for rather than read once. The reveal is driven by the
    // `BetSettled` watcher while the fairness verdict above comes from the history hook,
    // so the two can land a render apart, and a one-shot `getAttribute` can catch
    // "drawing" on the chain-backed tier this suite runs on.
    const reveal = page.getByTestId("reveal");
    await expect(reveal).toHaveAttribute("data-phase", /^(won|lost)$/);
    const won = (await reveal.getAttribute("data-phase")) === "won";
    await expect(page.getByTestId("reveal-figure")).toHaveText(won ? "+190" : "1");

    // The sentence that makes the number mean something. Asserted because without it
    // nothing does: `lossExplanation` has its own unit tests, and deleting the line that
    // renders it left every one of them green.
    await expect(page.getByTestId("reveal-miss-reason")).toHaveCount(won ? 0 : 1);
    if (!won) {
      await expect(page.getByTestId("reveal-miss-reason")).toHaveText("A win was roll 0, 1-in-2.");
    }

    await expect(page.getByTestId("verify-link")).toBeVisible();
    await expect(page.getByTestId("place-bet")).toBeEnabled();

    // The record has to be checkable independently, which is the whole fairness claim.
    const href = await page.getByTestId("verify-link").getAttribute("href");
    expect(href).toContain("/verify");

    // The newest play is the one just made, at the stake it was made at.
    await expect(page.locator(historyRows).first()).toContainText("100 RUSH");

    // The stake left the balance either way, so it cannot read as it did before.
    await expect(page.getByTestId("balance")).not.toHaveText(before as string);
  });

  test("reports a declined wallet prompt instead of hanging", async ({ page, wallet }) => {
    const handle = await connectAs(page, wallet);
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
