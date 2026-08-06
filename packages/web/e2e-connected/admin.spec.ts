import {
  ETHEREUM_CHAIN_ID,
  HARDHAT_CHAIN_ID,
  OPERATOR,
  OUTSIDER,
  connectAs,
  expect,
  test,
} from "./fixtures/wallet";

/**
 * The admin console's network gating.
 *
 * The hole review found: a governance holder on the wrong chain saw live pause and
 * submit buttons whose transactions could not land. The fix passes `wrongNetwork` to
 * the panels as its own prop rather than folding it into the role flags, and that
 * distinction is the thing these tests are really protecting. Folded in, the console
 * tells a governance holder they are "Not authorised", and sends the one person who
 * can fix an emergency looking for a permissions problem they do not have.
 *
 * So it is not enough to assert the buttons are disabled. The copy has to name the
 * network, and must not claim anything about their role.
 */
test.describe("admin console on the wrong network", () => {
  test("disables pause, and says why without impugning the role", async ({ page, wallet }) => {
    await connectAs(page, wallet, {
      address: OPERATOR,
      chainId: ETHEREUM_CHAIN_ID,
      path: "/admin",
    });

    await expect(page.getByTestId("admin-console")).toBeVisible();
    await expect(page.getByTestId("pause-toggle")).toBeDisabled();

    const reason = page.getByTestId("pause-wrong-network");
    await expect(reason).toBeVisible();
    await expect(reason).toContainText("on another network");
    await expect(reason).toContainText("Switch to Hardhat to pause");

    // The whole point of the separate prop. This account holds the guardian role.
    await expect(page.getByTestId("pause-denied")).toHaveCount(0);
    await expect(page.getByText("Not authorised")).toHaveCount(0);
    await expect(page.getByTestId("access-denied")).toHaveCount(0);
  });

  test("disables submit, and labels it as a network problem", async ({ page, wallet }) => {
    await connectAs(page, wallet, {
      address: OPERATOR,
      chainId: ETHEREUM_CHAIN_ID,
      path: "/admin",
    });

    const submit = page.getByTestId("op-submit");
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText("Switch to Hardhat to sign");
    await expect(submit).not.toHaveText("Not authorised to change parameters");
  });

  test("shows the same banner the play page shows", async ({ page, wallet }) => {
    await connectAs(page, wallet, {
      address: OPERATOR,
      chainId: ETHEREUM_CHAIN_ID,
      path: "/admin",
    });

    await expect(page.getByTestId("wrong-network")).toBeVisible();
    await expect(page.getByTestId("wrong-network")).toContainText("You're on Ethereum");
  });

  test("lifts the gate once the operator switches chain", async ({ page, wallet }) => {
    const handle = await connectAs(page, wallet, {
      address: OPERATOR,
      chainId: ETHEREUM_CHAIN_ID,
      path: "/admin",
    });
    await expect(page.getByTestId("pause-toggle")).toBeDisabled();

    await handle.setChain(HARDHAT_CHAIN_ID);

    await expect(page.getByTestId("wrong-network")).toHaveCount(0);
    await expect(page.getByTestId("pause-toggle")).toBeEnabled();
    await expect(page.getByTestId("pause-wrong-network")).toHaveCount(0);
    await expect(page.getByTestId("op-submit")).toBeEnabled();
  });
});

test.describe("admin console access", () => {
  test("turns away an account holding no role, and says so plainly", async ({ page, wallet }) => {
    // The other message, and the one that must NOT appear for a real operator on the
    // wrong chain. Asserting it here pins the two apart.
    await connectAs(page, wallet, { address: OUTSIDER, chainId: HARDHAT_CHAIN_ID, path: "/admin" });

    await expect(page.getByTestId("access-denied")).toBeVisible();
    await expect(page.getByTestId("access-denied")).toContainText("holds none of this deployment");
    await expect(page.getByTestId("admin-console")).toHaveCount(0);
  });

  test("opens for an operator on the right chain", async ({ page, wallet }) => {
    await connectAs(page, wallet, { address: OPERATOR, chainId: HARDHAT_CHAIN_ID, path: "/admin" });

    await expect(page.getByTestId("admin-console")).toBeVisible();
    await expect(page.getByTestId("pause-toggle")).toBeEnabled();
    await expect(page.getByTestId("operator-roles")).toBeVisible();
  });
});
