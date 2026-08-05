# CLAUDE.md

Mainnet-intent, real-value "pick your odds" number-prediction game on Robinhood Chain (4663).
npm workspaces: `packages/contracts` (Hardhat/Solidity), `packages/web` (Next.js + wagmi), `packages/verifier` (pure TS fairness verifier).

This file is an index and a list of traps.
It deliberately does not restate what the linked files already say.

## Read these, in this order

| Path | Why |
|---|---|
| `AGENTS.md` | Repo conventions and the prettier trap. Short on `main`; the fuller version is on PR #46. |
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
