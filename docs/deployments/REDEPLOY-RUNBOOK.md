# Testnet 46630 redeploy runbook

For the redeploy that pays down five `.sol` changes at once and freezes the source for the audit.
Written against `main` at the #58 merge, and brought forward to the #60 merge, which is where the checklist stamp step 2 relies on came from.
Every command here is run **by the owner**, with the `!` prefix, for the reason in "Why you run these" below.

## Before you start

The tree is the thing being frozen, so prove it is the tree you think it is.

```
git -C "<repo>" log --oneline -1        # expect the #58 merge commit
git -C "<repo>" status --short          # expect no modified tracked files
```

`deployments/` is gitignored, and `deploy-launch` overwrites `deployments/robinhoodTestnet.json` in place.
A copy of the pre-run state is in this session's scratchpad; make your own if you are running later.

## Rehearsal status

Re-run on **2026-08-13** against the post-#58 tree, on a local node at `LOCAL_RPC_PORT=8548` because another project held 8545.

- `deploy-launch` clean, and the unlocked-remainder warning fired as it should.
- `launch-checklist` **23/23**.
- A raw slot read off the deployed game confirmed the packed layout survives #58: `guardian` alone in slot 1, `minBet` and `treasuryFloor` full-width in slots 2 and 3 forcing a fresh boundary, and the whole economic block in slot 4 as 29 bytes (`economicsGovernable=false`, `edgeNum=95`, `edgeDen=100`, `solvencyCapDen=100`, `burnRateBps=250`).
- `MIN_SOLVENCY_CAP_DEN` reads 20 and `maxPayout / treasuryBalance` is exactly 1.00%, so #58's floor is live and the seeded default is unchanged.

So steps 1 and 2 were proven on the exact tree being frozen before the real run, and step 3 could not be, the script refusing a local node by design.

All three have since been run for real against 46630.
See "What the 2026-08-13 run actually did" at the end.

## Why you run these, and not the agent

Your global settings hard-deny `Bash(npx hardhat run:*)`, `hardhat deploy:*` and `hardhat verify:*`.
A deny rule cannot be lifted by approving a prompt.

The repo's npm scripts wrap the same binary and `Bash(npm run *)` is allowlisted, so `npm run deploy:launch` would route a denied command through an allowed alias.
That is not done here.

It is also not *possible* for the two scripts that matter, which is worth knowing rather than discovering mid-run:

```
deploy:launch   hardhat run scripts/deploy-launch.ts   --network localhost
checklist       hardhat run scripts/launch-checklist.ts --network localhost
```

Both hardcode `--network localhost`, so `npm run deploy:launch -- --network robinhoodTestnet` appends a second flag and Hardhat rejects it:

```
HH309: Repeated parameter --network
```

That is a good failure - it cannot silently deploy to the wrong place - but it means the npm aliases have no route to 46630 at all.
Invoke Hardhat directly, as below.

`verify:publish` is the exception: its script carries no `--network`, so appending one is unambiguous there.

## Environment

**Nothing in this repo imports `dotenv`.**
`packages/contracts/.env` is never loaded automatically.
Export what the run needs into the shell yourself, or `requireEnv` throws and the defaults quietly apply where they exist.

From `packages/contracts`:

```
set -a; . ./.env; set +a
```

Required on a public network.
**Five of the seven throw when absent; two do not**, and the two that do not are the reason to check this table rather than trust the run to tell you.

| Variable | Absent behaviour |
|---|---|
| `RELAYER_SEED` | Throws. `requireEnv` on any non-local network. |
| `GOVERNANCE_SAFE` | Throws. `requireEnv` off local. Last run: `0x226623db3FB34b6d2E42CDAC5b337DF7Ce4CBbf8`. |
| `TEAM_BENEFICIARY` | Throws. `requireEnv` off local. Last run: `0x35cBaA536AFFDB19ee6B4c43190D5B7Eec8BDeF2`. |
| `UNISWAP_POSITION_MANAGER` | Throws. Both this and `WETH_ADDRESS` must be set off local, or `resolveUniswap` throws. |
| `WETH_ADDRESS` | Throws. Same check, same throw. |
| `ROBINHOOD_TESTNET_RPC_URL` | **Does not throw as missing.** The config defaults it to `""`, so it fails later as a bad URL. |
| `TESTNET_PRIVATE_KEYS` | **Does not throw at all.** `accountsFromEnv()` in `hardhat.config.ts` falls back to `DEPLOYER_PRIVATE_KEY`, then to an empty list, so a typo here yields a network with no signers rather than an error naming the variable. Comma-separated. The checklist needs **distinct** deployer, relayer, player and guardian addresses, or its access-control checks pass for the wrong reason. |

Defaulted, so check them rather than assume them:

| Variable | Default if unset |
|---|---|
| `LP_ETH_AMOUNT` | 0.05 ETH on testnet, which is what the 2026-07-27 run used. Mainnet's default is 25 ETH. |
| `LP_FEE_TIER` | 3000, which is what the last run used. |
| `TIMELOCK_MIN_DELAY` | 172800 (2 days), matching the last run. |
| `ALLOW_PARTIAL_LP_SEED` | Unset behaves as false, and the run **aborts** if any of the liquidity allocation would go unseeded. See below. |
| `RELAYER_CHAIN_LENGTH` | The script's `DEFAULT_CHAIN_LENGTH`. |
| `BLOCKSCOUT_TESTNET_URL` | `https://explorer.testnet.chain.robinhood.com`. |

### Uniswap on 46630

This chain has **no canonical Uniswap v3**, so one was self-deployed for the 2026-07-27 run and is still live.
It is unaffected by anything in the five contract changes, so it does not need redeploying:

```
UNISWAP_POSITION_MANAGER=0x1a3C8a593B480669f320B579EAA0a138345Affd3
WETH_ADDRESS=0x9e4Ef21Ced7FA4276bd00ceB5BC965046D3f378b
```

If you would rather stand up a fresh one, `scripts/deploy-uniswap-v3.ts` is the script and it writes `deployments/uniswap-robinhoodTestnet.json`.

### `ALLOW_PARTIAL_LP_SEED` is a disclosure decision, not a convenience flag

At the pinned 1e-7 price, 0.05 ETH seeds 500,000 RUSH against a 250,000,000 RUSH liquidity allocation.
The other 249,500,000 goes to the Safe, **unlocked**.
The run refuses to proceed with that gap unless the flag is `true`.

If you set it, the published address list has to say so.
The current doc does say so, and it says so because an earlier version claimed "25% liquidity held by RushoodLPLock" while ~24.95% of supply sat outside the lock.
Do not let the regenerated file lose that paragraph.

## The run

From `packages/contracts`, with the environment exported.

### 1. Deploy

```
npx hardhat run scripts/deploy-launch.ts --network robinhoodTestnet
```

Writes `deployments/robinhoodTestnet.json`.
Every one of the six contracts gets a **new address**; the 2026-07-27 set stays on chain and becomes abandoned.

Read the header it prints before it does anything irreversible, and confirm all four roles are the addresses you meant:

```
Launch deployment on robinhoodTestnet (chain 46630)
  deployer         ...
  safe / guardian  ...
  team beneficiary ...
  relayer          ...
```

### 2. Checklist

```
npx hardhat run scripts/launch-checklist.ts --network robinhoodTestnet
```

23 items.
Exits non-zero on any failure.

Two things about this one:

- **It takes over an hour**, because one item waits out a real `SETTLE_TIMEOUT` to prove the refund path.
  Interruption is the normal case, not the exception.
- **An interrupted run leaves a bet in flight**, and one-active-bet means every later `placeBet` reverts `BetAlreadyActive`.
  The checklist settles a leftover bet first, so a re-run recovers itself.
  That behaviour is why it exists; do not work around it by hand.

Negative items rely on `scripts/lib/revert-matching.ts`, because a real RPC returns raw ABI-encoded error bytes where Hardhat's node returns a decoded object.

**This step must complete, because step 3 publishes its result.**
The run writes `deployments/checklist-robinhoodTestnet.json`, stamped with all six addresses it exercised, and step 3 credits that result to the published page only if the stamp matches the stack it is publishing.
That file is gitignored and `deploy-launch` does not clear it, so **an earlier deployment's record sits exactly where this one's would**.
Before #60 the only join was the filename, and the 2026-08-13 run duly published six brand-new addresses under a checklist that had run against the contracts they had just replaced.
`chainId` cannot rescue this: it is identical across every redeploy of the same chain.
If the checklist is skipped or left unfinished, step 3 reports "not run against this deployment" rather than crediting the stale record, which is the intended outcome and not a bug to work around.

### 3. Verify and publish

```
npx hardhat run scripts/verify-and-publish.ts --network robinhoodTestnet
```

**Pass `--network robinhoodTestnet` explicitly.**
This script's npm alias carries no network, so it would otherwise default to the in-process `hardhat` network, which the script rejects: `isLocalNetwork` counts `hardhat` alongside `localhost`, and the guard throws `Nothing to verify on a local node` before it reads anything.
That is a safe failure rather than a wrong document.
The hazard `--network` guards against is a mis-targeted **public** network, because `explorerBaseUrl()` falls back to the **mainnet** Blockscout for any chain that is not 46630.

**This half had never been rehearsed and could not be**, the script refusing to run on a local node by design, so the localhost dry runs only ever covered steps 1 and 2.
It has now been run for real once; see "What the 2026-08-13 run actually did" below.

**`hardhat-verify` is broken against this Blockscout, and nothing here uses it.**
It sends constructor arguments without the `0x` prefix this Blockscout demands, so #26 replaced it with `scripts/lib/blockscout-verify.ts`, which is what `verify-and-publish.ts` imports and calls.
Do not budget for a manual verify on that basis.
Budget instead for the bespoke submitter being the thing under test, and note it **counts an already-verified contract as a pass** - so on a redeploy confirm the *source* is current rather than the status, by fetching `/api/v2/smart-contracts/<addr>` and grepping the returned source for a symbol only the new version has.

### 4. Manual verification - contingency only, not expected

**The 2026-08-13 run did not need any of this**, and step 3 went 6/6 automatically.
Keep this section as the fallback for a contract the submitter cannot place, and do not read it as a step to budget for.

If it is needed, it is done **via agent-browser**, against the Blockscout UI at `https://explorer.testnet.chain.robinhood.com`.

Six contracts to verify: `Rushood`, `Treasury`, `RushoodGame`, `RushoodVesting`, `RushoodLPLock`, `RushoodTimelock`.

What the form needs, and where it comes from:

- **Compiler** `0.8.24`, optimizer **enabled**, **200** runs, `evmVersion` **cancun**.
  All four are in `hardhat.config.ts` and all four must match or the bytecode will not.
- **Constructor arguments**, ABI-encoded.
  `verify-and-publish.ts` already assembles these per contract in its `targets` array; take them from there rather than rebuilding them.
- **Standard JSON input** is the reliable route on Blockscout.
  Build artifacts are under `artifacts/build-info/`; read each unit through its own artifact's `.dbg.json` rather than picking a build-info file directly, because stale ones from earlier compiles are left behind and describe code that no longer exists.

## After the run

- `docs/deployments/robinhoodTestnet.md` is regenerated by step 3.
  **Drop the stale banner**, which names #47's packing and is about the old source.
- Read the regenerated **Launch checklist** section before committing.
  If it says "not run against this deployment", step 2's record did not match the stack being published, and committing would publish a worse claim than the one the stamp exists to prevent.
- Confirm the regenerated file still discloses the unlocked LP remainder.
- **Issue #47 closes here, and not before.**
  Its last acceptance criterion is the republished address list, which is this.
- Update `packages/web` if it pins any of the six addresses, and check `lib/chain.ts`.
- The relayer needs repointing at the new game address before the app works against this deployment.

## What the 2026-08-13 run actually did

Steps 1 to 3 were run for real against 46630 on 2026-08-13.
This section is the record; everything above it is the procedure.

- **Deploy** at `01:40:51Z`.
  Six new addresses, listed in `docs/deployments/robinhoodTestnet.md`.
- **Checklist** finished `02:43:43Z`, **23/23**, the hour being the real `SETTLE_TIMEOUT` wait.
- **Verify and publish** verified **6/6 automatically** through `scripts/lib/blockscout-verify.ts`.
  No manual submission was needed, and step 4 was never entered.
- Confirmed on chain rather than from the deploy log: `MIN_SOLVENCY_CAP_DEN` reads 20, `maxPayout` is exactly 1.00% of the treasury, and raw slot 4 is byte-identical to the localhost rehearsal, so #55's packing survived #58.

Two things the run taught that the procedure above now carries:

- **The publisher credited the wrong checklist.**
  It published the six new addresses under a 23/23 result from a run against the contracts they had just replaced, because the only join was a per-network filename.
  PR #60 stamps the six addresses into the record and compares them.
  Step 2 above says so.
- **Uniswap sorts pool tokens by address, so the redeploy flipped `token0` and `token1`.**
  The new RUSH sorts above WETH where the old one sorted below, and `sqrtPriceX96` correctly inverted from 2.505e25 to 2.505e32.
  The pinned 1e-7 price is unchanged.
  A raw comparison of those two numbers looks like a catastrophic repricing and is not.

## What this does not clear

The redeploy freezes the source.
It does not start the audit, and it clears none of the owner-owned gates: the independent security audit, gambling and legal compliance, trademark review of "RUSHOOD", the 25 ETH mainnet LP seed, or the systemd install drill.
The shipped disclosure says the contracts are not yet audited.
Keep it that way.
