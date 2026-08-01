import { test, expect } from "@playwright/test";

/**
 * The `/verify` tool is pure arithmetic - no chain, no wallet - so unlike the play
 * flow it can be exercised properly in CI. These fixtures are a real roll: `commitment`
 * is keccak256(serverReveal), and the roll/win values are what the contract itself
 * produces for these inputs (pinned against `RushoodGame.outcomeOf` in the contract
 * suite's Fairness tests).
 */

const REVEAL = "0xecf638d7e4c03aec20d7589fe1eace75e4b3530b2b618452d294cb8cd86b8907";
const COMMITMENT = "0x403866023b59601c2d62e26330a45036540bffba90381562eda42d45abdc7c40";

/** bet #7, moonshot tier, entropy 42 → roll 248 of 1000: a miss. */
const MOONSHOT_MISS = {
  betId: "7",
  tier: "5",
  clientEntropy: "42",
  serverReveal: REVEAL,
  commitment: COMMITMENT,
  win: "false",
  roll: "248",
};

/** The same reveal and entropy on the coin flip → roll 0: a win. */
const COINFLIP_WIN = { ...MOONSHOT_MISS, tier: "0", win: "true", roll: "0" };

function link(params: Record<string, string>): string {
  return `/verify?${new URLSearchParams(params).toString()}`;
}

test("a verify link recomputes the roll and passes", async ({ page }) => {
  await page.goto(link(MOONSHOT_MISS));
  await expect(page.getByTestId("verify-verdict")).toContainText("PASS");
  await expect(page.getByTestId("verify-roll")).toContainText("mod 1000 = 248");
  await expect(page.getByTestId("verify-roll")).toContainText("LOSS");
});

test("a winning roll is recomputed as a win", async ({ page }) => {
  await page.goto(link(COINFLIP_WIN));
  await expect(page.getByTestId("verify-verdict")).toContainText("PASS");
  await expect(page.getByTestId("verify-roll")).toContainText("mod 2 = 0");
  await expect(page.getByTestId("verify-roll")).toContainText("WIN");
});

test("the verifier quotes the same multipliers as the odds ladder", async ({ page }) => {
  // Integer division would render the coin flip as "1×" here while the ladder says
  // "1.9×" - two numbers for one payout, on the page whose whole job is trust.
  await page.goto(link(COINFLIP_WIN));
  await expect(page.getByTestId("verify-result")).toContainText("1.9×");

  await page.goto(link(MOONSHOT_MISS));
  await expect(page.getByTestId("verify-result")).toContainText("950×");

  await page.goto("/");
  await expect(page.getByTestId("rung-0")).toContainText("1.9×");
});

test("confirms the hash-chain link - the reveal matches the commitment", async ({ page }) => {
  await page.goto(link(MOONSHOT_MISS));
  await expect(page.getByTestId("verify-chain-link")).toContainText("✓");
  await expect(page.getByTestId("verify-chain-link")).toContainText(
    "revealed the number it was locked into",
  );
});

test("a reveal that does not hash to the commitment fails the chain link", async ({ page }) => {
  // Swap in a reveal the house never committed to.
  await page.goto(
    link({
      ...MOONSHOT_MISS,
      serverReveal: "0x" + "ab".repeat(32),
    }),
  );
  await expect(page.getByTestId("verify-verdict")).toContainText("FAIL");
  await expect(page.getByTestId("verify-chain-link")).toContainText("✕");
});

test("a tampered client entropy no longer reproduces the reported roll", async ({ page }) => {
  await page.goto(link({ ...MOONSHOT_MISS, clientEntropy: "43" }));
  await expect(page.getByTestId("verify-verdict")).toContainText("FAIL");
  await expect(page.getByTestId("verify-reported")).toContainText("✕");
});

test("a tampered bet id no longer reproduces the reported roll", async ({ page }) => {
  await page.goto(link({ ...MOONSHOT_MISS, betId: "8" }));
  await expect(page.getByTestId("verify-verdict")).toContainText("FAIL");
  await expect(page.getByTestId("verify-reported")).toContainText("✕");
});

test("inputs can be typed in by hand, with no link and no chain", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByTestId("verify-result")).toHaveCount(0);

  await page.getByTestId("verify-betId").fill(MOONSHOT_MISS.betId);
  await page.getByTestId("verify-tier").selectOption(MOONSHOT_MISS.tier);
  await page.getByTestId("verify-clientEntropy").fill(MOONSHOT_MISS.clientEntropy);
  await page.getByTestId("verify-commitment").fill(COMMITMENT);
  await page.getByTestId("verify-serverReveal").fill(REVEAL);
  await page.getByTestId("verify-run").click();

  await expect(page.getByTestId("verify-verdict")).toContainText("PASS");
  await expect(page.getByTestId("verify-roll")).toContainText("mod 1000 = 248");
});

test("malformed input is reported per field rather than silently failing", async ({ page }) => {
  await page.goto("/verify");
  await page.getByTestId("verify-betId").fill("7");
  await page.getByTestId("verify-commitment").fill("not-a-hash");
  await page.getByTestId("verify-run").click();
  await expect(page.getByText("commitment must be a 32-byte hex value")).toBeVisible();
  await expect(page.getByTestId("verify-result")).toHaveCount(0);
});

test("the fairness model is disclosed in plain language, residual included", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByTestId("fairness-formula")).toContainText(
    "keccak256(serverReveal, yourEntropy, betId)",
  );

  const residual = page.getByTestId("fairness-residual");
  // The disclosure is only worth anything if it names what's still trusted - including
  // the parts that don't flatter the house.
  await expect(residual).toContainText("The house runs the secret chain");
  await expect(residual).toContainText("not the zero-trust guarantee of an on-chain VRF");
  await expect(residual).toContainText("The house knows your result before you do");
  await expect(residual).toContainText("stall specifically on winning bets");
  await expect(residual).toContainText("The house picks when to settle");
  await expect(residual).toContainText("take your stake back");
  await expect(residual).toContainText("only as good as your browser");
  await expect(residual).toContainText("The house edge is real");
  await expect(residual).toContainText("not yet audited");
});

test("the game links out to the verifier", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("verify-nav").click();
  await expect(page.getByRole("heading", { name: "Verify a roll" })).toBeVisible();
});
