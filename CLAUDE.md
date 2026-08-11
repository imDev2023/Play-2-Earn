# CLAUDE.md

Mainnet-intent, real-value "pick your odds" number-prediction game on Robinhood Chain (4663).
npm workspaces: `packages/contracts` (Hardhat/Solidity), `packages/web` (Next.js + wagmi), `packages/verifier` (pure TS fairness verifier).

This file is an index and a list of traps.
It deliberately does not restate what the linked files already say.

## Read these, in this order

| Path | Why |
|---|---|
| `AGENTS.md` | Repo conventions, the prettier trap, and the **review cadence**. |
| `docs/spec/RUSHOOD-game-spec.md` | The product spec, and the authority for the Spec axis of `/code-review`. |
| `docs/agents/issue-tracker.md` | Issues live as GitHub issues, driven by `gh`. |
| `docs/deployments/robinhoodTestnet.md` | The only deployment that exists. Currently marked stale, see below. |
| `docs/ops/dependency-advisories.md` | Six high advisories are open and accepted. CI gates at `critical`, not `high`. |
| `~/Documents/agent-guides/web3-e2e-testing.md` | How to drive a wallet in tests. Not in this repo, by owner decision. Read before touching e2e or a wallet. |
| `packages/contracts/lib/evm-security-standards/` | Submodule at profile `robinhood-4663`, installed 2026-08-06. **On `chore/wire-security-gate` only - #54 is open, not merged.** The repo is public so CI can clone it; a private submodule fails every job at checkout, because `GITHUB_TOKEN` is scoped to this repo alone. Contracts now import property mixins from it, so **any checkout without `submodules: recursive` cannot compile**. **The authority for any chain question** - read `profiles/robinhood-4663.md` rather than answering from general knowledge. Supersedes the Solidity half of `web3-security.md`. |
| `resources/01-robinhood-chain.md` | Untracked. Crawled platform facts for chain 4663: Arbitrum Nitro L2, ArbOS semantics, ERC-8056, the 48-hour feed gap, and the confirmation that **there is no L2 sequencer uptime feed on 4663** - which closes one of the profile's two `OPEN:` answers. |
| `resources/web3-security.md` | Untracked. All four links checked and nothing actionable is left: the only one the package does not cover is the 15-second timestamp rule, and the 3600s refund window clears it. |

## Deployment reality

**There is no mainnet deployment.** Only Robinhood Chain testnet 46630, deployed 2026-07-27.
Verify with `git log --all --diff-filter=A -- 'docs/deployments/*'`.
The README's "mainnet, real-value" opening is product intent; `lib/chain.ts` hard-codes no mainnet endpoints on purpose.

Editing a `.sol` file breaks source verification for that deployment - the whole reason the freeze existed.
It costs one testnet redeploy, not a migration, and `hardhat-verify` is broken against that Blockscout so budget for a manual verify.

**That debt is now owed four times over**, which is the argument for paying it once rather than per change: #48 repacked `RushoodGame`'s storage, #54 moved `evmVersion` to `cancun` and added `Treasury.GameSet`, and #47 packed the five economic parameters into one slot.
The deployed 46630 bytecode no longer matches the tree on any of the four counts.
Do it once, and pay the manual Blockscout verify once.

**Three of the four change the public ABI, not just the bytecode**, so they can break a consumer rather than merely a verification badge.
#48 was the first and is still the sharpest: it reordered the `bets()` tuple and narrowed `placedAt` to `uint64` and `betCounter`/`activeBetId` to `uint128`, and a reordered output tuple is the silent kind (see the positional-decode trap below).
#54 added `Treasury.GameSet`, which is additive.
#47 narrowed five getters: `edgeNum`, `edgeDen`, `solvencyCapDen`, `burnRateBps` and `MAX_BURN_RATE_BPS` now return `uint56`.
Anything holding a hand-written ABI has to move with it: `packages/web/lib/contracts.ts` did, and `packages/web/test/abi-matches-artifact.test.ts` is what forces the issue.
The width is not arbitrary and must not be "tidied" narrower - abitype decodes `<= 48` bits as a JS `number` and `>= 56` as a `bigint`, and the admin console reads these through `at<bigint>`, which casts rather than infers, so a `uint32` would typecheck green and then throw `Cannot mix BigInt and other types` on first render.

## Traps that cost time

**Never hand a wagmi watcher a function built during render.**
`useWatchContractEvent` lists `onLogs` in its effect dependencies (read it in `node_modules/wagmi/dist/esm/hooks/useWatchContractEvent.js`), so a new identity tears the subscription down and opens another - and every log emitted in that gap is lost, silently.
An inline arrow, or anything built by calling a factory during render, is a new identity every render.
This sat latent for months because the play screen was static between bets; #51 made it re-render on every block while one is pending (`useBlock({watch})` plus a 5s `activeBetId` poll) and it started dropping `BetPlaced`.
The row was then built by `BetSettled` alone - stake `0`, no `clientSeed`, no `commit` - so `verifyInputsFor` returned null and the fairness verdict *vanished after having rendered*.
`lib/useStableCallback.ts` is the fix, used at all five call sites. Memoising is not enough: these handlers close over things that legitimately churn.

**A chain read taken to back up an event can be older than the event.**
`hydrate` reads `bets()` after `BetPlaced`, and that reply is a pre-settlement snapshot; writing it straight over the row erased the reveal `BetSettled` had already delivered - the same vanished verdict, reached from the other side, and the ordinary case rather than a corner.
`hydrateEntry` merges instead: the chain is authoritative about what it knows, not about what it has not caught up to.

**Both bugs above were invisible to every unit test and caught by `e2e-connected/bet.spec.ts`.**
That suite now runs in CI as the `connected-e2e` job (#49 landed). It is the only tier that has ever caught a bug in this area, so a change to the bet or refund path is not verified until it is green.

**The `bets()` tuple decodes positionally, so a reorder puts every field in its neighbour without throwing.**
An address is still an address, and Typechain returns named tuples so contract tests pass whatever the order is.
Any consumer derives its field order from the ABI and never hard-codes one; the guards are `packages/web/test/abi-matches-artifact.test.ts` (#53) and `toBetView` / `BetViewNamesMatchAbi` / `RawBet` in `lib/contracts.ts` (#51). Read those, not this paragraph.
Three positional sites remain - `VerifyTool.tsx` and `useRelayerHealth.ts` twice. Migrate them onto `toBetView`.

**The durable lesson: this trap bit three times *inside the code written to prevent it*, and a fourth time during the merge that was supposed to end it.**
`toBetView` shipped positional, then fixed the order but cast away the names. #53, the guard for exactly this, shipped ignoring `indexed`. Then #48's repack collided with #51's `hydrate`; git showed that conflict only because both sides happened to touch the same lines, and it would otherwise have merged clean and silently wrong.
No test caught any of them. Review and the merge caught them all. That is the entire argument for the cadence.

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
The cadence is in `AGENTS.md` (on `main` since #52) and is not restated here; what belongs here is why it keeps being skipped.
A fix closing a finding feels like the end of a review rather than the start of one, and it is written under the impression that the problem is already understood - the exact state in which a fix reproduces the bug it was meant to remove.
Both `toBetView` revisions above were written that way.
Size is not a proxy for risk: "it is small" is the reasoning that shipped #48 red and put the positional bug on #51's branch.

**A PR body claiming a green suite is not evidence.**
`gh pr checks <n>` is, and only for the commit the remote actually has - a branch ahead of its remote makes even that stale, which is the sharper form of the same trap.
PR #48 sat red for a day behind a body that said "typecheck clean".
A tool reporting `pass` is not evidence either: CodeRabbit shows `pass` with the note "Review rate limited", which means it never ran.
Read the note, not the column.

**Chain 4663 has no randomness, and that is why this game is shaped as it is.**
`packages/contracts/lib/evm-security-standards/profiles/robinhood-4663.md` is the authority; read it before answering any chain question, never from general knowledge.
It confirms `prevrandao` is a constant and there is no VRF on the production path, so the bespoke commit-reveal is not over-engineering, it is the only option.
The profile's headline hazard, the ERC-8056 multiplier, **does not apply here** (no contract reads a price) and is waived in `.evm-standards.json` with the reasoning.
One answer in that profile is still `OPEN:` - re-org depth. Do not invent it. The other, the sequencer uptime feed, is now closed: **there is no such feed on 4663 at all**, so the guard the Robinhood docs recommend cannot be built. See `resources/01-robinhood-chain.md`.

**The security gate is wired on #54, which is pushed and fully green but still open, awaiting the owner's merge.** 37 pass, 0 fail, 10 unanswered in CI.
`python3 lib/evm-security-standards/gate/check.py --project .` from `packages/contracts`.
Locally it reports 35 pass and 2 failures, and that is correct rather than broken: `q-slither-clean` and `v-invariants-in-ci-hardhat` read evidence that only CI produces, merged into `.evm-standards.json` by the gate job.
Two review rounds ran over the fix commits themselves and both found real defects, which is the cadence earning its keep rather than a formality.

**The 10 unanswered items are load-bearing, not leftovers.**
`check.py` passes an attested item on **any non-empty string**, so writing "no, because ..." into `attestations` silently turns a negative into a pass.
Anything untrue is therefore left absent. All ten, because a partial list here once read as exhaustive: `arch-multisig`, `arch-value-cap`, `q-no-warnings-hardhat`, `v-fork-tests`, `v-coverage`, `v-audit`, `v-bounty`, `ops-runbook`, `ops-contact`, `ops-bytecode`.
Never "answer" one to tidy the report.

**`evmVersion` is `cancun`, chosen by probing the chain rather than from the parent family.**
Both 4663 and 46630 report ArbOS 61 and accept BASEFEE, PUSH0, MCOPY, TSTORE and TLOAD; they reject **BLOBBASEFEE** by name, and BLOBHASH with it.
That is safe only because solc emits those two solely when something asks for them, so `test/EvmTarget.ts` guards it.
Hardhat's default here was `paris`, which is not solc 0.8.24's own default.
That guard reads **solc's build-info**, not the `contracts/` directory, and the reason is worth keeping: a directory scan is only as wide as the path it was given and only as literal as the syntax its author imagined.
The first version missed the Yul spelling `blobbasefee()` and never looked at the submodule templates that `RushoodProperties` compiles.
Two tests, because they cover different regions: the runtime scan reads solc's own disassembly, and a separate source scan covers constructors, whose creation bytecode embeds other contracts' runtime and cannot be disassembled to a reliable end.
Read each unit through its own artifact's `.dbg.json`; build-info files are left behind by earlier compiles and reading them whole reports code that no longer exists.

**Slither's config filters mocks and the properties harness** like `test/` and `script/`, added in #54 after a `locked-ether` finding in `MockNonfungiblePositionManager` failed it at `fail_on: medium`.

**A green CI step is not proof the step did anything.**
Three of the gate's five defects were steps that succeeded while achieving nothing, and each cost a full CI round trip to find.
`upload-artifact@v4` skips **hidden files** by default, so uploading `.evm-standards.json` produced no artifact and warned rather than failed - the gate then failed downstream for want of evidence CI had just recorded. Pair `include-hidden-files: true` with `if-no-files-found: error`; the second half is the one that matters.
`defaults.run.working-directory` does **not** apply to an action's `path:`, so a download and the `run` step consuming it can silently disagree about where they are.
And a release archive is not its toolchain: Medusa shells out to `crytic-compile`, a separate Python package.

**A bounded fuzz handler decides which states the campaign can reach.**
The solvency property could not find a deliberately planted break, because the handler burned a uniformly random slice of the treasury and the violating region was the last ~1% of that range.
Put the extremes in as their own zero-argument calls rather than trusting the sampler to land on them. `handleBurnAllProfit` in `contracts/properties/RushoodProperties.sol` is that fix.
Corollary, and the rule that governs this whole area: **prove the check fails on a planted bug before believing it passes** - the run that "passed" first was measuring nothing.

It then bit a second time, in the property written to answer the first review, and the shape is worth keeping because it is subtler.
`handlePlaceBet` folds its stake into `[minBet, maxBet]` so the campaign spends its budget on play, which also means **no sequence it can generate ever breaches the cap** - so `invariant_payoutWithinCap`'s "the win stays inside maxPayout" assertion stayed green with the `stake > maxBet(tier)` check deleted from `placeBet` outright.
A folded input is a silent restriction on the reachable state space, and the assertion about the state you folded away is the one that cannot fail.
`handlePlaceOverCapBet` is that fix.
The same assertion was also measured against a live `maxPayout()` re-read at assertion time, which the stake had by then inflated; it is snapshotted at placement now, because the contract caps against the pool the bet *joined*.

**A check that recomputes the implementation and then compares that recomputation to itself passes for every input.**
The #54 review found the pure form of it. `test/RoundingDirection.ts` computed `const burned = (stake * bps) / den` in TypeScript and asserted `burned * den <= stake * bps` - an identity of integer division, true whatever the contract does, and it never called the contract at all.
It reads exactly like a real test, and a waiver pointed at it as the evidence for `arith-rounding-tested`.
Anchor an assertion to the **spec's numbers**, and read the actual value **back off the chain**. Both halves matter: the rewrite settles real bets and reads the `StakeBurned` amount plus the `totalSupply` delta.
The same defect in property form is subtler: `_activeLiability` derived its expectation from `game.payoutFor`, so a wrong multiplier would inflate expectation and payout **together** and conservation would keep holding while every winner was paid the wrong number. `invariant_payoutWithinCap` is the fix and is the only property that catches that class.

**An attestation is only as good as the reading behind it, and reading a file is not reading a contract.**
`cf-no-unbounded-loops` claimed six named contracts contain no loop. True of the six *files*; false of `RushoodTimelock`, which inherits OZ `TimelockController` and its caller-supplied array loops.
Nothing counter-checks this: `slither.config.json` sets `exclude_dependencies: true`, so static analysis never looks at inherited code.
Three more attestations were stale in the same direction, each because the PR's own new files changed a count the attestation had stated as absolute.
When an attestation says "there are exactly N" or "none exist", re-grep it after every commit in the same PR.

**Everything a workflow fetches is pinned, and a new workflow will forget.**
The rule is stated in a comment at `.github/workflows/ci.yml:18`.
`evm-security.yml` shipped with all 17 of its `uses:` tag-pinned, and `ci.yml`'s own `connected-e2e` job (from #49) had three more; every `uses:` in the repo is now a 40-hex SHA with the release in a trailing comment.
Resolve the tag **already in use** to its SHA rather than taking whatever the action's latest release is: at the time of writing, the six `actions/*` in use were two to four majors behind, and pinning is not the moment to take a major bump.
**The rule does not stop at `uses:`.**
The commit that pinned all 17 left `curl .../releases/latest/download/medusa-linux-x64.tar.gz` untouched two steps below its own comment condemning exactly that, on a binary that then executes against the contracts.
Now `v1.5.1` plus a SHA256 check, and the checksum is the half that matters: a tag can be moved and a release asset replaced, and neither shows up as a diff.
Pin to the version the recorded evidence was produced with, so an upgrade that changes what a campaign explores has to be a deliberate commit that re-runs the plants.
Least privilege travels with it: `evm-security.yml` ran with the default token grant while running more third-party code than any other workflow here, until it got `permissions: contents: read` to match `ci.yml`.

**`npm run lint` and CI's lint step must stay the same command.**
They did not, and the divergence hid a red CI job behind a green local one for a full session: the script omitted `--max-warnings 0`, so it exited 0 on the three solhint warnings that made CI's Lint step exit 1.
The fix is one copy, not two matching ones: `evm-security.yml`'s Solhint step now runs `npm run lint` rather than spelling the command out again.
This is the local-command form of "a PR body claiming a green suite is not evidence" - if the command you run to check is not the command the gate runs, it is not a check.
Note that `ci.yml`'s own Lint step is the root `npm run lint`, which fans out to every workspace, so tightening the contracts script tightened that job too.

**Check for path collisions before adding a file while another PR is in review** with `git diff main...<other-branch> --stat`. An ABI-order pin once landed at exactly the path #48 was already creating.

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
`docs/ops/web3-security-review.md` is an engineering pass against published checklists, explicitly not the audit.
