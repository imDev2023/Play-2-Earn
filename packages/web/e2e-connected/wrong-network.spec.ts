import { ETHEREUM_CHAIN_ID, HARDHAT_CHAIN_ID, connectAs, expect, test } from "./fixtures/wallet";

/**
 * The wrong-network guard.
 *
 * This is the bug that got furthest. `NetworkOnboarding` was written correctly and
 * read the wrong chain: `useChainId()` reports the wagmi *config's* chain, and wagmi
 * refuses to move that to a chain it was not configured with, so a wallet on
 * Ethereum still read as 31337. The banner never rendered, and the app showed a live
 * `Place bet · 100 RUSH` button to somebody whose wallet could not sign for it.
 *
 * No test caught it, and no test could have: the mock connector cannot report a chain
 * outside the config, so the wrong network was unreachable from a test. It took a
 * human pointing a real wallet at the app. These tests reach it.
 */
test.describe("wrong network", () => {
  test("names the chain the player is actually on", async ({ page, wallet }) => {
    await connectAs(page, wallet, { chainId: ETHEREUM_CHAIN_ID });

    const banner = page.getByTestId("wrong-network");
    await expect(banner).toBeVisible();
    // "You're on Ethereum", not "You're on Chain 1". The label's whole job is to
    // match what the player can read in their own wallet.
    await expect(banner).toContainText("You're on Ethereum");
    await expect(banner).toContainText("Switch to Hardhat to play");
  });

  test("disables the bet button while the banner is showing", async ({ page, wallet }) => {
    await connectAs(page, wallet, { chainId: ETHEREUM_CHAIN_ID });

    await expect(page.getByTestId("wrong-network")).toBeVisible();

    const bet = page.getByTestId("place-bet");
    await expect(bet).toBeDisabled();
    // The label has to say why. A disabled button with its normal copy reads as a
    // broken app rather than a wallet on the wrong chain.
    await expect(bet).toHaveText("Switch network to play");
  });

  test("lifts the gate when the app's own switch button is used", async ({ page, wallet }) => {
    const handle = await connectAs(page, wallet, { chainId: ETHEREUM_CHAIN_ID });
    await expect(page.getByTestId("wrong-network")).toBeVisible();

    await page.getByTestId("switch-network").click();

    await expect(page.getByTestId("wrong-network")).toHaveCount(0);
    await expect(page.getByTestId("place-bet")).toBeEnabled();
    await expect(page.getByTestId("place-bet")).toContainText("Place bet");
    expect(await handle.chainId()).toBe(HARDHAT_CHAIN_ID);
  });

  test("lifts the gate when the player switches in their wallet", async ({ page, wallet }) => {
    // The other half of the same guard. A player who switches network in the wallet
    // UI never touches the app's button, and the banner still has to clear.
    const handle = await connectAs(page, wallet, { chainId: ETHEREUM_CHAIN_ID });
    await expect(page.getByTestId("wrong-network")).toBeVisible();

    await handle.setChain(HARDHAT_CHAIN_ID);

    await expect(page.getByTestId("wrong-network")).toHaveCount(0);
    await expect(page.getByTestId("place-bet")).toBeEnabled();
  });

  test("raises the gate when the player leaves the chain mid-session", async ({ page, wallet }) => {
    // The direction that actually loses money. Betting is live, the player switches
    // away, and the button has to stop being live before the next click.
    const handle = await connectAs(page, wallet, { chainId: HARDHAT_CHAIN_ID });
    await expect(page.getByTestId("place-bet")).toBeEnabled();

    await handle.setChain(ETHEREUM_CHAIN_ID);

    await expect(page.getByTestId("wrong-network")).toBeVisible();
    await expect(page.getByTestId("place-bet")).toBeDisabled();
  });

  test("shows no banner for a wallet that is already on the right chain", async ({
    page,
    wallet,
  }) => {
    // The negative case, so that the five tests above cannot pass by the banner
    // simply always showing. It does not catch a *flash* of the banner during
    // connection - an awaited assertion cannot observe a state that has already
    // gone - so `isWrongNetwork` returning false for an undefined chain is left to
    // the unit tests in test/chain.test.ts, where it can be checked directly.
    await connectAs(page, wallet, { chainId: HARDHAT_CHAIN_ID });

    await expect(page.getByTestId("place-bet")).toBeEnabled();
    await expect(page.getByTestId("wrong-network")).toHaveCount(0);
  });
});
