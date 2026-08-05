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

## Deployment reality

**There is no mainnet deployment.** Only Robinhood Chain testnet 46630, deployed 2026-07-27.
`git log --all --diff-filter=A -- 'docs/deployments/*'` shows testnet commits and nothing else.
The README's "mainnet, real-value" opening line is product intent, not a deployed fact, and `lib/chain.ts` hard-codes no mainnet endpoints on purpose.

Editing a `.sol` file breaks source verification for the testnet deployment, which is why the freeze existed.
It was described as protecting a mainnet deployment; that was wrong.
PR #48 deliberately breaks it and marks `docs/deployments/robinhoodTestnet.md` stale rather than leaving a false "verified" column.

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

**Ports.** Never use 3000 or 3100; other projects bind them.
Confirm the title says RUSHOOD before trusting anything you see.
A backgrounded `next dev` exits the moment its stdin hits EOF; hold it open with `tail -f /dev/null | PORT=<port> npm run dev -- --port <port>`.

## Owner-owned, never claim these are done

The independent security audit, gambling/legal compliance, trademark review of "RUSHOOD", 25 ETH for the mainnet LP seed at the locked 1e-7 price, and the systemd install drill.
The shipped fairness disclosure says the contracts are unaudited; keep it that way.
`docs/ops/web3-security-review.md` (on `chore/security-headers`) is an engineering pass against published checklists, explicitly not the audit.
