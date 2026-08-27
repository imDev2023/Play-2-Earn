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
| `docs/deployments/robinhoodTestnet.md` | The only deployment that exists. Republished by the 2026-08-13 redeploy; the stale banner is gone because the redeploy is what it asked for. |
| `docs/deployments/REDEPLOY-RUNBOOK.md` | How the redeploy was actually run, including the `HH309` trap and which env vars throw against which default silently. |
| `docs/ops/dependency-advisories.md` | Six high advisories are open and accepted. CI gates at `critical`, not `high`. |
| `~/Documents/agent-guides/web3-e2e-testing.md` | How to drive a wallet in tests. Not in this repo, by owner decision. Read before touching e2e or a wallet. |
| `packages/contracts/lib/evm-security-standards/` | Submodule at profile `robinhood-4663`, on `main` since #54 merged (2026-08-11). Public, so CI can clone it; a private submodule fails every job at checkout, because `GITHUB_TOKEN` is scoped to this repo alone. Contracts import property mixins from it, so **any checkout without `submodules: recursive` cannot compile**. **The authority for any chain question** - read `profiles/robinhood-4663.md` rather than answering from general knowledge. Supersedes the Solidity half of the untracked `resources/web3-security.md`, which is spent and no longer has a row of its own. |
| `resources/01-robinhood-chain.md` | Untracked. Crawled platform facts for chain 4663: Arbitrum Nitro L2, ArbOS semantics, ERC-8056, the 48-hour feed gap, and the confirmation that **there is no L2 sequencer uptime feed on 4663** - which closes one of the profile's two `OPEN:` answers. |

## Deployment reality

**There is no mainnet deployment.**
Only Robinhood Chain testnet 46630, redeployed 2026-08-13.
Verify with `git log --all --diff-filter=A --name-only -- 'docs/deployments/*'`, which names two files and **one deployment record**: `robinhoodTestnet.md`, plus `REDEPLOY-RUNBOOK.md`, which is procedure rather than a record.
A deployment record here is named after its network, so a mainnet one would be impossible to miss.
The README's "mainnet, real-value" opening is product intent.
**`lib/chain.ts` now commits the real mainnet endpoints, and that is not readiness.**
It withheld them under #26 because the chain had not published them and a guessed RPC is worse than a missing one; they were published on 2026-07-31, so the comment saying otherwise had been false for a month while `hardhat.config.ts` already defaulted to the same explorer.
What stops a mainnet build is `lib/addresses.ts`, which has no 4663 entry and throws at module load, so the wrong artefact is never produced at all - a harder gate than the message it replaces, which only appeared once a player had loaded the page.
The bridge is still env-only, because "the canonical Arbitrum bridge" has no URL to commit, and `gasHelpUrl` returns null rather than a guess.
**`packages/contracts/hardhat.config.ts` deliberately does not follow, and leaves `robinhoodMainnet.url` empty.**
A web build that can read 4663 is harmless; a contracts package with a working mainnet URL makes `--network robinhoodMainnet` a live deploy target.
Do not tidy the two halves into agreement.
Note the spec's §10 still plans the production RPC through Alchemy, which is a deployment choice reachable through `NEXT_PUBLIC_ROBINHOOD_RPC_URL`, not a contradiction of the public default.

**The five-change redeploy debt is paid.** #48's repack, #54's `cancun` and `Treasury.GameSet`, #55's packed slot and #58's `MIN_SOLVENCY_CAP_DEN` are all on chain, verified against post-#58 source.
Addresses are in `docs/deployments/robinhoodTestnet.md`; the runbook that produced them is `docs/deployments/REDEPLOY-RUNBOOK.md`.
Confirmed on chain rather than from the deploy log: `MIN_SOLVENCY_CAP_DEN` reads 20, and slot 4 is byte-identical to the localhost rehearsal, so #55's packing survived #58.
**#47 closes on PR #62**, the republished list, which is its last acceptance criterion.

Editing a `.sol` file breaks source verification again, so the freeze holds until the audit is done.

**`hardhat-verify` is broken against this Blockscout, and it does not matter**, which is the correction worth carrying.
It sends constructor arguments without the `0x` prefix this Blockscout demands, so #26 replaced it with `scripts/lib/blockscout-verify.ts`, and `verify-and-publish.ts` uses that.
The 2026-08-13 run verified **6/6 automatically**; the manual agent-browser path was never needed.
Do not re-record "budget for a manual verify" - budget instead for the bespoke submitter being the thing under test.
Note it counts an already-verified contract as a pass, so on a redeploy confirm the *source* is current rather than the status.
**Compare whole files, not a symbol.**
Fetch `/api/v2/smart-contracts/<addr>` and diff the returned source against the repo's `.sol` on normalised whitespace; all six matched on 2026-08-13 at solc 0.8.24, `cancun`, 200 runs.
Grepping for "a symbol only the new version has" is the tempting shortcut and it went wrong twice in one commit: it covered two of six contracts, and one symbol chosen was `Treasury.setGame`, which dates from the walking skeleton and so appears in the *replaced* source too.
#54's symbol is the `GameSet` event.
A whole-file compare needs no such judgement and cannot be fooled by a name that was always there.

**The npm aliases cannot reach 46630 at all.**
`deploy:launch` and `checklist` hardcode `--network localhost`, so appending another makes Hardhat throw `HH309: Repeated parameter --network`.
That is a safe failure rather than a silent localhost deploy, but it means `npx hardhat run <script> --network robinhoodTestnet` is the only route, which is also the form the owner's deny rules reserve for the owner.
`verify:publish` is the exception and takes an appended network, because its script declares none.

**A per-network filename cannot join to a per-deployment result**, and that shipped once.
Fixed in #60; `scripts/lib/checklist-record.ts`'s header is the full account and the authority.
The durable half: ask what identifies a *deployment* before joining on anything a redeploy leaves unchanged.
`chainId` was already in the record and could not help, being identical across every redeploy of the same chain.
**The 2026-08-13 record was hand-stamped**, the run predating the stamp, and `deployments/` is gitignored - so a fresh checkout has no record and republishing there would honestly report "not run".
Re-run the checklist rather than re-stamping by hand a second time.

**Uniswap sorts pool tokens by address, so a redeploy can flip token0 and token1.**
The new RUSH sorts above WETH where the old one sorted below, and `sqrtPriceX96` correctly inverted from 2.505e25 to 2.505e32.
The pinned 1e-7 price is unchanged; a raw comparison of the two numbers looks like a catastrophic repricing and is not.

**Nothing in this repo imports `dotenv`.**
`packages/contracts/.env` is never loaded automatically, so every variable the real run needs must be exported into the shell by hand, or `requireEnv` throws and the fallbacks silently apply where they exist.

**The `uint56` width is load-bearing and must not be "tidied" narrower.**
abitype decodes `<= 48` bits as a JS `number` and `>= 56` as a `bigint`, and the admin console reads these through `at<bigint>`, which **casts rather than infers**.
A `uint32` would therefore typecheck green and throw `Cannot mix BigInt and other types` on first render.

## Traps that cost time

**A wagmi call with no `chainId` does not use the chain the app is configured for.**
It resolves to the connected wallet's chain, or with no wallet to `wagmiConfig.chains[0]`, which is `hardhat` - so a testnet build with no wallet reads `127.0.0.1:8545`, meaning whoever answers there.
This is the client-side twin of the `--network localhost` trap below, same port, other half of the repo.
Found the first time the app was pointed at 46630 (issue #63): `/verify`'s lookup returned `bets returned no data ("0x")` because another project's `anvil` held 8545.
Fixed on PR #65 - and the issue's list of eight unpinned sites was a lower bound, the fix pinned eighteen call sites, so grep the primitives rather than trusting a site list.
That count itself shipped as "seventeen" in PR #65's own commit message, unverified; the review of the docs recording it recounted.
Every call now pins `chainId: activeChainId`, and `packages/web/test/chain-pinning.test.ts` is the guard: a closed world over wagmi imports walking the whole package, so a new unpinned call or an unclassified wagmi import fails the unit suite.
Its own history repeats the repo's sharpest lesson twice - the first walk missed `components/`, and the first skip list matched at every depth, where an `app/test/` would be a shipped route.
**Neither e2e suite could catch the bug**, both running against a local node where the configured chain and `chains[0]` are the same value - the folded-input lesson from the fuzzing section arriving in the client.
`test/chain-divergence.test.ts` now makes the two differ and proves at the transport boundary which endpoint an unpinned versus pinned read asks.
Prove which chain answered by moving *only* `NEXT_PUBLIC_RPC_URL` (the local transport) and seeing a supposedly-testnet read change behaviour.

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
PR #65 migrated the last positional consumers, so every `bets()` decode now goes through `toBetView`; if `grep -rn "bets("` ever finds a new positional one, that is a regression, not a leftover.

**The durable lesson: this trap bit three times *inside the code written to prevent it*, and a fourth time during the merge that was supposed to end it.**
`toBetView` shipped positional, then fixed the order but cast away the names. #53, the guard for exactly this, shipped ignoring `indexed`. Then #48's repack collided with #51's `hydrate`; git showed that conflict only because both sides happened to touch the same lines, and it would otherwise have merged clean and silently wrong.
No test caught any of them. Review and the merge caught them all. That is the entire argument for the cadence.

**The two e2e suites want opposite worlds.**
`playwright.config.ts` asserts the disconnected UI and its admin specs assert the chain is *unreachable*, so it needs the Hardhat node stopped.
`playwright.connected.config.ts` needs the node running with the skeleton deployed and the relayer settling.
Hence two configs and two CI jobs.

**Two `next dev` servers started from `packages/web` share `.next`, and the later one's environment silently wins.**
`NEXT_PUBLIC_*` is inlined at compile time, so the second server's build overwrites the first's client chunks and the first then serves someone else's chain.
A testnet-configured app was found calling `127.0.0.1:8548` at the *local skeleton* address and reporting "Couldn't reach the contract: HTTP request failed", which is issue #63's symptom exactly and was nothing of the kind.
Neither the console nor the network panel settled it: the panel showed CORS preflights with no POST after them, which looks like a blocked request rather than a request to somewhere else.
Patching `window.fetch` in the page to log the URL it was actually given is what named the real endpoint in one step.
Run one dev server at a time, and clear `.next` whenever you change which chain a build targets.

**A gitignored `packages/web/.env` retargets both e2e suites, and only on a working machine.**
It supplies `NEXT_PUBLIC_CHAIN_ID` and the addresses when the shell does not, so a `.env` naming the testnet turned 12 of the 19 connected specs into "Switch network to play" while CI, which has no `.env`, stayed green.
Green in CI and red locally points every suspicion at the tests.
`localChainEnv` in `playwright.base.ts` now pins the chain for the server *that config starts*, and `test/e2e-chain-env.test.ts` fails if it is ever unwired; it cannot help with a stray server that is already running, which is the trap above.

**Cap Playwright workers on a chain-backed suite.**
Every worker holds a browser polling one single-threaded Hardhat node.
At the default the connected bet spec failed about one run in three; at 4 workers it passed 8 consecutive runs and got *faster* (12.5s against 16s).
If a chain-backed suite times out intermittently, lower the worker count before touching the tests.

**wagmi's `mock` connector cannot express a wrong network.**
It is built from `wagmiConfig.chains`.
This is why the #45 wrong-network bug was untestable until the injected EIP-6963 provider in `packages/web/e2e-connected/fixtures/wallet.ts`.
That fixture signs against its own `nodeUrl`, which follows `LOCAL_RPC_PORT` only since PR #65: hardcoded 8545, a relocated node made bet *writes* fail as an opaque RPC error while every read worked, which looks like an app bug and is a harness port split.
The same split ran the other way until the app's transport followed the port too, and both now read one `localNodeUrl` in `playwright.base.ts` rather than two copies of the same expression.

**Do not onboard a wallet extension for manual driving.**
Adapt that same fixture into a plain IIFE and pass it to `agent-browser --init-script`.
No onboarding, no popups, survives reloads, and it exposes `rejectNextTransaction()` and `setChain()` - a declined prompt and a wrong network on demand, which a real wallet cannot give you reliably.
Reserve a real extension for verifying extension-specific behaviour only; see `docs/metamask-agent-browser.md` for that path and its LavaMoat trap.
If `agent-browser eval` starts returning `""`, check `get url` - the tab has gone to `about:blank` and every result since is meaningless.

**A commit that answers a review finding needs its own review.**
The cadence is in `AGENTS.md` (on `main` since #52) and is not restated here; what belongs here is why it keeps being skipped.
A fix closing a finding feels like the end of a review rather than the start of one, and it is written under the impression that the problem is already understood - the exact state in which a fix reproduces the bug it was meant to remove.
Both `toBetView` revisions above were written that way, and size is not a proxy for risk: "it is small" is the reasoning that shipped #48 red and put the positional bug on #51's branch.
**Every round on PR #55, #56 and #58 found something real** - do not write a tally here, because it is stale the next time this rule is obeyed.
Docs-only fix commits are not exempt; a wrong sentence here is worse than a wrong sentence anywhere else, because this is the file the next session trusts.
The sharpest evidence: a fix here rewrote one line so a leading `#47` would stop rendering as an H1 heading, then opened another line in the same commit with `#56`, reintroducing the hazard it had just fixed.
**That hazard is not real, and finding that out took one command.**
GFM needs a space after the `#` run, so `gh api -X POST /markdown -f mode=gfm -f text='#47 stays open'` returns a `<p>`, not an `<h1>`; only legacy Markdown.pl-family renderers promote it.
The `PR ` prefix is still worth keeping as a house style, because a bare number is the PR/issue conflation this file warns about twice - but keep it for that reason, not for a rendering bug that was never checked against a renderer.
It survived several rounds of review because it reads like exactly the sort of thing that would be true.
**When a claim appears in two files, fixing one of them is the default failure**, and naming the trap in a commit message does not stop you doing it in that same commit.
**Verify a finding before you write it down**, including one a review sub-agent hands you: a report's "one line below its own fix" was seventy-five lines out, and went in unchecked because every round before it had been right.

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

**The security gate is wired and on `main`** (#54, merged 2026-08-11). 37 pass, 0 fail, 10 unanswered in CI.
`python3 lib/evm-security-standards/gate/check.py --project .` from `packages/contracts`.
**Locally it reports 35 pass and 2 failures, and that is correct rather than broken**: `q-slither-clean` and `v-invariants-in-ci-hardhat` read evidence only CI produces, merged into `.evm-standards.json` by the gate job. Do not "fix" those two locally.

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

**Solidity fills storage slots greedily, so a packed block placed after an address silently straddles two of them.**
PR #55 packed five economic parameters into 29 bytes and got *two* slots, not one: `guardian` is an `address` with 12 spare bytes, and the first two fields of the block moved in to fill them.
The gas claim was then simply false, and nothing about the source looked wrong.
`minBet`/`treasuryFloor` (full-width `uint256`s) now sit ahead of the block to force a fresh boundary.
**Prove a layout claim by reading the raw slot off the chain** - `test/StoragePacking.ts` does, and caught this on its first run; reading the declaration back out of the `.sol` file only restates the thing under test.
Note `storageLayout` is not in this project's solc `outputSelection`, so `eth_getStorage` is the available route.

**Narrowing a storage type silently narrows every setter that writes it.**
`setEdge` and `setSolvencyCap` took an unbounded `den`; after packing, an over-wide value would have *truncated*, and for the solvency cap truncation runs in the dangerous direction - a deliberately tight cap wrapping into a loose one.
Bound the setter in the same commit, and keep the bound a consequence of the layout (`MAX_ECONOMIC_RATIO` is `type(uint56).max`) rather than smuggling an economic policy change into a storage PR.
Watch the arithmetic too: `uint56 * uint56` is evaluated **in** `uint56`, so `maxBet` needed an explicit `uint256(...)` widening or a governance-settable value would overflow and brick every `placeBet`.

**A bound on the safe end of a range reads as coverage for the whole range.**
That is why issue #57 sat unnoticed: `setSolvencyCap` rejected a *large* `den` so the setter looked bounded, while `maxPayout` is `treasuryBalance() / solvencyCapDen` and the danger is a *small* one, with `den == 1` setting maxPayout to the entire treasury.
Ask which direction is dangerous before reading a bound as protection, because the two bounds here have unrelated causes: `MAX_ECONOMIC_RATIO` is storage width, `MIN_SOLVENCY_CAP_DEN` is economic policy, and their declarations say so to stop the next reader treating them as one kind of thing.
Spec §5 now records both numbers, 1% seeded and 5% the loosest governance can reach, and **the contract enforces the 5%, not the 1%** - do not restate that as "the 1% is enforced".

**A contract bound that `packages/web/lib/admin/ops.ts` does not mirror is a queued timelock call that reverts two days later.**
That module exists for exactly this and says so in its header, so adding a setter bound is a two-file change by default.
PR #58's first commit added `MIN_SOLVENCY_CAP_DEN` to `GAME_ABI` and gave it no consumer, leaving the console offering `den: 1`; both review axes found it independently.
Bounds carry a `minReason`/`maxReason` so the operator reads *why*, not just a number.

**A green CI step is not proof the step did anything.**
Three of the gate's five defects were steps that succeeded while achieving nothing, and each cost a full CI round trip to find.
`upload-artifact@v4` skips **hidden files** by default, so uploading `.evm-standards.json` produced no artifact and warned rather than failed - the gate then failed downstream for want of evidence CI had just recorded. Pair `include-hidden-files: true` with `if-no-files-found: error`; the second half is the one that matters.
`defaults.run.working-directory` does **not** apply to an action's `path:`, so a download and the `run` step consuming it can silently disagree about where they are.
And a release archive is not its toolchain: Medusa shells out to `crytic-compile`, a separate Python package.
**Medusa itself can report a green campaign against a stale compilation.** A planted cap-check deletion once returned `14/0` while the plant was provably live (`OddsTiers.ts` was red on the same tree); three repeats on identical source all returned `13/1`, and the run that disagreed did not print crytic-compile's `Finished compiling targets` line. Not fully isolated - so grep the campaign output for that line before believing a pass.

**A bounded fuzz handler decides which states the campaign can reach.**
The solvency property could not find a deliberately planted break, because the handler burned a uniformly random slice of the treasury and the violating region was the last ~1% of that range.
Put the extremes in as their own zero-argument calls rather than trusting the sampler to land on them. `handleBurnAllProfit` in `contracts/properties/RushoodProperties.sol` is that fix.
Corollary, and the rule that governs this whole area: **prove the check fails on a planted bug before believing it passes** - the run that "passed" first was measuring nothing.

It bit a second time, subtler: `handlePlaceBet` folds its stake into `[minBet, maxBet]`, so **no sequence the campaign can generate ever breaches the cap** and `invariant_payoutWithinCap` stayed green with the `stake > maxBet(tier)` check deleted from `placeBet` outright.
A folded input silently restricts the reachable state space, and the assertion about the state you folded away is the one that cannot fail. `handlePlaceOverCapBet` is that fix, plus an at-placement `maxPayout` snapshot (a live re-read is inflated by the stake being tested).

A third time, and the widest form: **a parameter no handler writes is pinned for the whole run, so an assertion about it compares a constant to itself.**
`solvencyCapDen` sat at its seeded 100 because nothing flipped `economicsGovernable`, so `invariant_payoutWithinCap`'s cap assertion compared 1% against 1% on every call and could not fail whatever the contract did.
PR #58's two handlers fix it.
The harness header names which parameters are unreachable *and why*; when you make one reachable, correct that sentence, because the reason can change without the conclusion changing (the edge is still unreachable, but now only because no handler calls `setEdge`, not because the flag is off).
Watch the fold's own arithmetic: `medusa.json` sets `failOnArithmeticUnderflow: false`, so a handler whose range inverts reverts on every call and the campaign goes green having fuzzed nothing.

**Testing one half of a join tests neither.**
`checklist-record.ts` shipped with the reader covered by six tests and the writer's stamp sitting in an object literal in a script; deleting that stamp left **all 308 tests green**, and the failure would have been silent and permanent, since every later publish reads "not run" forever with nothing red to say why.
The fix is to put both halves behind one tested function, then prove each plant separately: the builder losing the stamp must fail a test, and the caller losing a field must fail `tsc`.
A guard is only ever as wide as what someone chose to write down, which is the same lesson `abi-matches-artifact.test.ts` learned when the constants it was meant to protect were simply absent from `GAME_ABI`.
Where a list and a type must agree, make that a compile error: `satisfies` plus an `Exclude<keyof T, ...> extends never` check, and plant a seventh field to confirm the guard is what fails rather than four unrelated call sites.

**Guard the container, not just the elements.**
The commit that hardened each address against `null` left the object holding them checked with `=== undefined`, so `"stack": null` sailed through and threw `Cannot read properties of null` mid-publish.
`null` is the specific value that defeats an `undefined` test while still being `typeof "object"`, and `JSON.parse` produces it from a file on disk.
This is the repo's recurring shape at its purest: **a fix reproducing the defect it was written to remove, in the same function, in the commit that fixed the level below** - so when you harden a level, ask what holds it.

**Restore a plant with a saved copy, never `git checkout --`.**
A plant script that restores from git silently discards uncommitted work in the same file, which is exactly the state a review-fix round is in.
It cost two comment fixes on #58 that had to be spotted and rewritten; nothing failed, and the only signal was the file being shorter than it should have been.

**A check that recomputes the implementation and then compares that recomputation to itself passes for every input.**
The #54 review found the pure form of it. `test/RoundingDirection.ts` computed `const burned = (stake * bps) / den` in TypeScript and asserted `burned * den <= stake * bps` - an identity of integer division, true whatever the contract does, and it never called the contract at all.
It reads exactly like a real test, and a waiver pointed at it as the evidence for `arith-rounding-tested`.
Anchor an assertion to the **spec's numbers**, and read the actual value **back off the chain**. Both halves matter: the rewrite settles real bets and reads the `StakeBurned` amount plus the `totalSupply` delta.
The same defect in property form is subtler: `_activeLiability` derived its expectation from `game.payoutFor`, so a wrong multiplier would inflate expectation and payout **together** and conservation would keep holding while every winner was paid the wrong number. `invariant_payoutWithinCap` is the fix and is the only property that catches that class.
It recurs, so expect it: #55's own `StoragePacking.ts` shipped `expect(expected >> 232n).to.equal(0n)`, where `expected` is a word the test builds with a top shift of exactly 232 - zero for every input, in the file written to prove a layout claim. Review caught it. **If both sides of an assertion come from the test, it asserts nothing.**

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
The fix is one copy, not two matching ones: `evm-security.yml`'s Solhint step now runs `npm run lint`, and `ci.yml`'s runs the root `npm run lint`, which fans out to every workspace.
If the command you run to check is not the command the gate runs, it is not a check.

**Check for path collisions before adding a file while another PR is in review** with `git diff main...<other-branch> --stat`. An ABI-order pin once landed at exactly the path #48 was already creating.

**`--network localhost` means whoever answers on 8545, unless the config says otherwise.**
Hardhat supplies a built-in `localhost` network when none is declared, and every deploy script here is hardcoded to that flag.
The rehearsal found 8545 held by another project's `anvil` forking BNB testnet, and `deploy-launch.ts` would have minted the genesis allocation into it without a word.
PR #56 declares `localhost` with `chainId: Number(LOCAL_CHAIN_ID)`, which is `31337n` in `scripts/lib/local-network.ts` - grep the constant, not the literal, because the literal does not appear in the config.
That makes Hardhat's own `ChainIdValidatorProvider` reject a foreign node on the first request, which is wider than any hand-placed check because it covers `hardhat test` and `hardhat console` too.
`LOCAL_RPC_PORT` moves the node and its clients off a busy port together.
**"Wider" stops at Hardhat's edge**, and the boundary is the part worth remembering: anything building its own provider is untouched by this.
`relayer-service.ts` was the live example, left unguarded while it required `RELAYER_RPC_URL` with no default and so had no silent-fallback hazard of this kind.
Issue #61 gave it a committed default (`RELAYER_NETWORK` names an entry in `scripts/service/networks.ts`), so the hazard appeared and the guard arrived with it: boot asserts the endpoint's chain id against the named entry, and the reasoning lives on `assertExpectedChain`.
Either way the guard proves *which chain* answered, not what state it holds: a forked node still reports 31337.

**The durable lesson from that review: a guard whose argument is fetched through the thing it guards can never run.**
Six sites called `assertLocalDevChain(network.name, chainId)` and fetched that `chainId` through the provider, four of them inline as `(await ethers.provider.getNetwork()).chainId`; the validator threw while the argument was still being evaluated, so the assert was never entered, and the stack trace pointed at *the assert's own line* - which is what made it look live.
A guard that cannot execute is worse than none, because the next reader trusts it.

**Ports.** Never use 3000 or 3100; other projects bind them, and 8545 is not reliably free either (see above).
Confirm the title says RUSHOOD before trusting anything you see.
A backgrounded `next dev` exits the moment its stdin hits EOF; hold it open with `tail -f /dev/null | PORT=<port> npm run dev -- --port <port>`.

## The player's escape hatch

`refund(betId)` returns the stake once `SETTLE_TIMEOUT` has elapsed.
Permissionless, works while paused, cannot be refused, and it does **not** advance the chain head - the reveal was never consumed.
It was absent from the web ABI entirely until #51, so the guarantee existed on-chain and nowhere a player could reach.
Anything that displays its deadline must read **chain** time, never the browser clock, and must never unlock the button before the contract would accept the call.

## Owner-owned, never claim these are done

The independent security audit, gambling/legal compliance, trademark review of "RUSHOOD", 25 ETH for the mainnet LP seed at the locked 1e-7 price, and the systemd install drill.
The shipped fairness disclosure says the contracts are not yet audited (`FairnessDisclosure.tsx`, that wording rather than "unaudited" - grep for the phrase, not the word); keep it that way.
`docs/ops/web3-security-review.md` is an engineering pass against published checklists, explicitly not the audit.

**The engineering is close to done; the launch is not, and the gap is not code.**
Owner chose full-audit-before-mainnet on 2026-08-12 rather than a capped guarded launch, so **the audit is the critical path** - it is external, it wants frozen source, and the 2026-08-13 redeploy froze it.
As of that date the audit has not been commissioned, so the critical path has not started.
Legal is the one that can invalidate a timeline rather than delay it, because a compliance answer can change the product; it costs nothing to run in parallel and should start earliest.
Do not read "all tickets closed" as "ready to launch"; that inference is what this section exists to block, and it was put to the test on 2026-08-13 when the frozen source and a 23/23 testnet run read as done.

**The answer to "how far from mainnet" is not in the code, so do not compute it from the code.**
Six of the ten unanswered gate items are launch gates rather than engineering gaps: `v-audit`, `v-bounty`, `ops-runbook`, `ops-contact`, `ops-bytecode` and `arch-multisig`.
`arch-multisig` is the sharpest of those on a real-money chain: `GOVERNANCE_SAFE` is a bare env address, which is fine on testnet and is the key to the treasury on mainnet.
The same session that reached "frozen and verified" also found a published page crediting a passing checklist to contracts it had never run against, through green CI and two review rounds - which is an argument for the audit rather than against the work.
Then the first time the *client* was pointed at that verified deployment, one button surfaced issue #63.
**"Testnet is green" has meant "the contracts are exercised", never "the product is."**
The 23/23 checklist is a script driving contracts through ethers and never renders a component, while every bug this project has actually shipped lives in the client.
Do not let the two claims stand in for each other.
