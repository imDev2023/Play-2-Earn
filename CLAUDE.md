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
| `packages/contracts/lib/evm-security-standards/` | Submodule, installed 2026-08-06 at profile `robinhood-4663`. **The authority for any chain question** - read `profiles/robinhood-4663.md` rather than answering from general knowledge. Supersedes the Solidity half of `web3-security.md`. |
| `web3-security.md` | Untracked at the repo root, four links, all checked. Only one still bears on code the package does not cover: Consensys "Timestamp Dependence", the 15-second rule. Our refund window is 3600s, so chain time is safe there. |

## Deployment reality

**There is no mainnet deployment.** Only Robinhood Chain testnet 46630, deployed 2026-07-27.
Verify with `git log --all --diff-filter=A -- 'docs/deployments/*'`.
The README's "mainnet, real-value" opening is product intent; `lib/chain.ts` hard-codes no mainnet endpoints on purpose.

Editing a `.sol` file breaks source verification for that deployment - the whole reason the freeze existed.
It costs one testnet redeploy, not a migration, and `hardhat-verify` is broken against that Blockscout so budget for a manual verify.

## Traps that cost time

**The `bets()` tuple decodes positionally, so a reorder puts every field in its neighbour without throwing.**
An address is still an address.
Contract tests cannot catch it: Typechain returns structs as named tuples, so they pass whatever the order is.
That is why every guard lives in the web package or in an explicitly hand-written-ABI test.

**The rule: any `bets()` consumer derives its field order from the ABI and never hard-codes one.**
Enforced by `packages/web/test/abi-matches-artifact.test.ts` (#53), which compares `GAME_ABI` and `RUSH_ABI` against the compiled artifacts, and by `toBetView` / `BetViewNamesMatchAbi` / `RawBet` in `lib/contracts.ts` (#51). Read those files rather than this paragraph.
Four positional call sites remain by choice - `VerifyTool.tsx`, `useBetHistory.ts`, `useRelayerHealth.ts` twice - because #48 is repacking the struct. Migrate them once it lands.

**This trap bit twice inside the helpers written to prevent it, and that is the durable lesson.**
`toBetView`'s first revision destructured by position; its second fixed the order and still shipped an unchecked cast so nothing checked *names*.
Then #53, the guard for exactly this, shipped ignoring `indexed` and treating event argument names as documentation - and viem returns `log.args` as an object, so `useBetHistory` reads them by name.
No test caught any of the three. Review caught all three, which is the whole argument for the cadence below.

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

**Chain 4663 has no randomness, and that is why this game is shaped as it is.**
`packages/contracts/lib/evm-security-standards/profiles/robinhood-4663.md` is the authority; read it before answering any chain question, never from general knowledge.
It confirms `prevrandao` is a constant and there is no VRF on the production path, so the bespoke commit-reveal is not over-engineering, it is the only option.
The profile's headline hazard, the ERC-8056 multiplier, **does not apply here**: no contract reads a price. The gate blocks on it anyway, so it wants a written waiver, not a fix.
Two answers in that profile are still `OPEN:` - re-org depth, and the sequencer uptime feed address. Do not invent either.

**The security gate is installed but unwired.**
`python3 lib/evm-security-standards/gate/check.py --project .` from `packages/contracts`.
Last run: 11 pass, 8 fail, 41 unanswered - which reads as "never filled in", not "broken". Slither passes by hand (one medium finding, in a mock); the gate fails it only because CI records no evidence into `.evm-standards.json`.
The one real code finding: **`evmVersion` is unset in `hardhat.config.ts`**, silently defaulting to `paris`, and the profile says set it explicitly. The supported version for 4663 is not documented there, so it needs a research pass, not a guess.

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
