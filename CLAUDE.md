# CLAUDE.md

Mainnet-intent, real-value "pick your odds" number-prediction game on Robinhood Chain (4663).
npm workspaces: `packages/contracts` (Hardhat/Solidity), `packages/web` (Next.js + wagmi), `packages/verifier` (pure TS fairness verifier).

This file is an index and a list of traps.
It deliberately does not restate what the linked files already say.

## Read these, in this order

| Path | Why |
|---|---|
| `AGENTS.md` | Repo conventions, the prettier trap, and the **review cadence**. Short on `main`; the prettier and advisories sections are on PR #46 and the review cadence on PR #52. |
| `docs/spec/RUSHOOD-game-spec.md` | The product spec, and the authority for the Spec axis of `/code-review`. |
| `docs/agents/issue-tracker.md` | Issues live as GitHub issues, driven by `gh`. |
| `docs/deployments/robinhoodTestnet.md` | The only deployment that exists. Currently marked stale, see below. |
| `docs/ops/dependency-advisories.md` | Six high advisories are open and accepted. CI gates at `critical`, not `high`. |
| `~/Documents/agent-guides/web3-e2e-testing.md` | How to drive a wallet in tests. Not in this repo, by owner decision. Read before touching e2e or a wallet. |
| `web3-security.md` | Four links, untracked at the repo root. Three are Solidity-only; SlowMist's front-end section is *only* HTTP security headers (PR #46). The one that bites client code is Consensys "Timestamp Dependence": the 15-second rule. |

## Deployment reality

**There is no mainnet deployment.** Only Robinhood Chain testnet 46630, deployed 2026-07-27.
Verify with `git log --all --diff-filter=A -- 'docs/deployments/*'`.
The README's "mainnet, real-value" opening is product intent; `lib/chain.ts` hard-codes no mainnet endpoints on purpose.

Editing a `.sol` file breaks source verification for that deployment - the whole reason the freeze existed.
It costs one testnet redeploy, not a migration, and `hardhat-verify` is broken against that Blockscout so budget for a manual verify.

## Traps that cost time

**The `bets()` tuple is destructured positionally, in five places.**
viem returns an array and the relayer uses a hand-written ethers fragment, so reordering the struct decodes every field into its neighbour without throwing.
An address is still an address.
The consumers are listed in the PR #48 body; two of them were missed on the first pass and caught only by review.
`packages/web/test/contracts.test.ts` and the hand-written-ABI test in `packages/contracts/test/RelayerService.ts` now guard it.

**This trap bit again inside the helper written to prevent it.**
`toBetView` (#51) exists to name those fields once, and its first revision destructured the tuple by position, like everything else.
#48 repacks the struct to `player, tier, settled, placedAt, stake, ...`; the two PRs touch different lines of `contracts.ts`, so they would have merged clean and left the helper reading `settled` out of the stake slot.
That is a truthy bigint, so pending-bet recovery would have bailed on every unsettled bet and the settlement panel would never have returned after a reload.
The second revision fixed the order and still shipped the same class of hole by another route: it widened the parameter to `readonly unknown[]` and returned an unchecked cast, so nothing checked *names* and nothing checked the call site.
Neither revision was caught by a test. Both were caught by reviewing the fix, which is the whole argument for the cadence below.

The rule this leaves: **any new `bets()` consumer derives its field order from the ABI and never hard-codes one.**
`toBetView` now zips against the `bets()` entry in `GAME_ABI`, the same declaration viem decodes against, so the two cannot disagree about order.
Names are pinned separately by `BetViewNamesMatchAbi`, a compile-time assertion that `BetView`'s keys and the ABI's declared output names are the same set; without it a rename leaves the field `undefined` on every decoded bet and the cast hides it.
`RawBet` is `ReadContractReturnType<typeof GAME_ABI, "bets">` rather than a hand-written tuple, so a reorder retypes the call site too.
What none of that checks is the hand-written `GAME_ABI` drifting from `RushoodGame.sol`; that is `test/contracts.test.ts`, which lives on #48.

**Contract tests cannot catch a field reorder.**
Typechain returns Solidity structs as named tuples, so they pass whatever the order is.
That is why the guards above live in the web package and in an explicitly hand-written-ABI test.

**The two e2e suites want opposite worlds.**
`playwright.config.ts` asserts the disconnected UI and its admin specs assert the chain is *unreachable*, so it needs the Hardhat node stopped.
`playwright.connected.config.ts` needs the node running with the skeleton deployed and the relayer settling.
Hence two configs and two CI jobs.

**Cap Playwright workers on a chain-backed suite.**
Every worker holds a browser polling one single-threaded Hardhat node.
At the default the connected bet spec failed about one run in three; at 4 workers it passed 8 consecutive runs and got *faster* (12.5s against 16s).
If a chain-backed suite times out intermittently, lower the worker count before touching the tests.

**wagmi's `mock` connector cannot express a wrong network.**
It is built from `wagmiConfig.chains`.
This is why the #45 wrong-network bug was untestable until the injected EIP-6963 provider in `packages/web/e2e-connected/fixtures/wallet.ts`.

**Do not onboard a wallet extension for manual driving.**
Adapt that same fixture into a plain IIFE and pass it to `agent-browser --init-script`.
No onboarding, no popups, survives reloads, and it exposes `rejectNextTransaction()` and `setChain()` - a declined prompt and a wrong network on demand, which a real wallet cannot give you reliably.
Reserve a real extension for verifying extension-specific behaviour only; see `docs/metamask-agent-browser.md` for that path and its LavaMoat trap.
If `agent-browser eval` starts returning `""`, check `get url` - the tab has gone to `about:blank` and every result since is meaningless.

**A commit that answers a review finding needs its own review.**
The cadence is in `AGENTS.md` (PR #52) and is not restated here; what belongs here is why it keeps being skipped.
A fix closing a finding feels like the end of a review rather than the start of one, and it is written under the impression that the problem is already understood - the exact state in which a fix reproduces the bug it was meant to remove.
Both `toBetView` revisions above were written that way.
Size is not a proxy for risk: "it is small" is the reasoning that shipped #48 red and put the positional bug on #51's branch.

**A PR body claiming a green suite is not evidence.**
`gh pr checks <n>` is.
PR #48 sat red for a day behind a body that said "typecheck clean".

**Check for path collisions before adding a file while another PR is in review.**
`git diff main...<other-branch> --stat` .
An ABI-order pin was added at exactly the path #48 already creates, which is the collision it was meant to prevent.

**Ports.** Never use 3000 or 3100; other projects bind them.
Confirm the title says RUSHOOD before trusting anything you see.
A backgrounded `next dev` exits the moment its stdin hits EOF; hold it open with `tail -f /dev/null | PORT=<port> npm run dev -- --port <port>`.

## The player's escape hatch

`refund(betId)` returns the stake once `SETTLE_TIMEOUT` has elapsed.
Permissionless, works while paused, cannot be refused, and it does **not** advance the chain head - the reveal was never consumed.
It was absent from the web ABI entirely until #51, so the guarantee existed on-chain and nowhere a player could reach.
Anything that displays its deadline must read **chain** time, never the browser clock, and must never unlock the button before the contract would accept the call.

## Owner-owned, never claim these are done

The independent security audit, gambling/legal compliance, trademark review of "RUSHOOD", 25 ETH for the mainnet LP seed at the locked 1e-7 price, and the systemd install drill.
The shipped fairness disclosure says the contracts are unaudited; keep it that way.
`docs/ops/web3-security-review.md` (on `chore/security-headers`) is an engineering pass against published checklists, explicitly not the audit.
