import { PLAYER, expect, test } from "./fixtures/wallet";

/**
 * The single connect button.
 *
 * #45 fixed a page that offered three - "Connect Injected", "Connect Mock Connector"
 * and "Connect MetaMask" - where two reached the same extension and the third signed
 * as a published Hardhat test key. Nothing failed when that shipped, because no test
 * had ever rendered the page with a wallet present. These do.
 */
test.describe("connect", () => {
  test("offers exactly one button, naming the wallet it will open", async ({ page, wallet }) => {
    await wallet({});
    await page.goto("/");

    const connect = page.getByTestId("connect-wallet");
    await expect(connect).toHaveCount(1);
    await expect(connect).toHaveText("Connect Rabby Wallet");

    // The two entries that produced the duplicates. Both still exist in the wagmi
    // config locally; the assertion is that neither reaches the page.
    await expect(page.getByRole("button", { name: /Connect Injected/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Mock/i })).toHaveCount(0);
    await expect(page.getByTestId("connect-alternative")).toHaveCount(0);
  });

  test("connects, and reports the account it connected", async ({ page, wallet }) => {
    await wallet({});
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();

    await expect(page.getByTestId("account")).toBeVisible();
    // The UI shortens it, so match on the halves it keeps rather than the whole.
    await expect(page.getByTestId("account")).toContainText(PLAYER.slice(0, 6));
    await expect(page.getByTestId("account")).toContainText(PLAYER.slice(-4));
    await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
  });

  test("falls back to the test wallet only when no real wallet announced", async ({ page }) => {
    // No wallet() call, so nothing announces and window.ethereum is absent. On a
    // local build the dev mock is still registered, and this is the one situation
    // it is allowed to win: nothing real to lose to.
    await page.goto("/");

    const connect = page.getByTestId("connect-wallet");
    await expect(connect).toHaveCount(1);
    await expect(connect).toHaveText("Connect test wallet");

    // The counterpart assertion - that it never wins from a wallet somebody actually
    // installed - is the `Mock` count in the first test. Both directions matter: the
    // mock signing as a published test key was being offered to real players.
  });
});
