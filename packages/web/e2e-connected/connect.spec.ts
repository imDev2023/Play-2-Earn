import { METAMASK_RDNS, PLAYER, connectAs, expect, test } from "./fixtures/wallet";

/**
 * The single connect button.
 *
 * #45 fixed a page that offered three - "Connect Injected", "Connect Mock Connector"
 * and "Connect MetaMask" - where two reached the same extension and the third signed
 * as a published Hardhat test key. Nothing failed when that shipped, because no test
 * had ever rendered the page with a wallet present. These do.
 *
 * The labels asserted here are the ones `connectLabel` actually produces: the generic
 * `injected()` fallback renders as "Connect wallet" and the dev mock as "Connect test
 * wallet". Matching on the pre-#45 strings would be an assertion that cannot fail.
 */
test.describe("connect", () => {
  test("offers exactly one button, naming the wallet it will open", async ({ page, wallet }) => {
    await wallet();
    await page.goto("/");

    const connect = page.getByTestId("connect-wallet");
    await expect(connect).toHaveCount(1);
    await expect(connect).toHaveText("Connect Rabby Wallet");

    // The two entries that produced the duplicates. Both still exist in the wagmi
    // config locally; the assertion is that neither reaches the page.
    await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect test wallet" })).toHaveCount(0);
    await expect(page.getByTestId("connect-alternative")).toHaveCount(0);
  });

  test("leads with MetaMask when several wallets announce", async ({ page, wallet }) => {
    // The rule `orderedConnectors` exists for. EIP-6963 announcement order is not
    // guaranteed, so "first one wins" would open a different wallet after a refresh.
    // Announcing two is the only way to tell that the ranking is doing anything.
    await wallet({ rdns: METAMASK_RDNS, name: "MetaMask" });
    await wallet({ rdns: "io.rabby", name: "Rabby Wallet" });
    await page.goto("/");

    await expect(page.getByTestId("connect-wallet")).toHaveText("Connect MetaMask");

    // The other wallet is offered rather than hidden - leading with one is a default,
    // not a restriction, for a player who keeps two and prefers the other.
    const alternatives = page.getByTestId("connect-alternative");
    await expect(alternatives).toHaveCount(1);
    await expect(alternatives).toHaveText("Rabby Wallet");
  });

  test("ranks announced wallets stably when MetaMask is absent", async ({ page, wallet }) => {
    // Alphabetical, for the same reason: the same wallet has to lead on every load.
    await wallet({ rdns: "io.zerion", name: "Zerion" });
    await wallet({ rdns: "io.rabby", name: "Rabby Wallet" });
    await page.goto("/");

    await expect(page.getByTestId("connect-wallet")).toHaveText("Connect Rabby Wallet");
    await expect(page.getByTestId("connect-alternative")).toHaveText("Zerion");
  });

  test("connects, and reports the account it connected", async ({ page, wallet }) => {
    await connectAs(page, wallet);

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

    // The counterpart - that it never wins from a wallet somebody actually installed
    // - is the "Connect test wallet" count of 0 in the first test. Both directions
    // matter: the mock signing as a published test key was offered to real players.
  });
});
