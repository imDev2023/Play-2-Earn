# Testnet 46630 redeploy runbook

For the redeploy that pays down five `.sol` changes at once and freezes the source for the audit.
Written against `main` at the #58 merge.
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

So steps 1 and 2 are proven on the exact tree being frozen.
Step 3 is not, and cannot be.

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

Required on a public network, each of which throws if absent:

| Variable | Why |
|---|---|
| `ROBINHOOD_TESTNET_RPC_URL` | The config defaults it to `""`, so an unset value fails as a bad URL rather than as a missing one. |
| `TESTNET_PRIVATE_KEYS` | Comma-separated. The checklist needs **distinct** deployer, relayer, player and guardian addresses, or its access-control checks pass for the wrong reason. |
| `RELAYER_SEED` | `requireEnv` on any non-local network. |
| `GOVERNANCE_SAFE` | `requireEnv` off local. Last run: `0x226623db3FB34b6d2E42CDAC5b337DF7Ce4CBbf8`. |
| `TEAM_BENEFICIARY` | `requireEnv` off local. Last run: `0x35cBaA536AFFDB19ee6B4c43190D5B7Eec8BDeF2`. |
| `UNISWAP_POSITION_MANAGER` | Both this and `WETH_ADDRESS` must be set off local, or `resolveUniswap` throws. |
| `WETH_ADDRESS` | Same check, same throw. |

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

### 3. Verify and publish

```
npx hardhat run scripts/verify-and-publish.ts --network robinhoodTestnet
```

**Pass `--network robinhoodTestnet` explicitly.**
This script's npm alias carries no network, so it would otherwise default to the in-process `hardhat` network - and `explorerBaseUrl()` falls back to the **mainnet** Blockscout for any chain that is not 46630, producing a document that points at the wrong explorer.

**This half has never been rehearsed and cannot be.**
The script refuses to run on a local node by design, so the localhost dry runs have only ever covered steps 1 and 2.

**`hardhat-verify` is known broken against this Blockscout.**
Expect step 3's verification calls to fail and the manual route to be needed.
That was the entire reason this redeploy waited for every `.sol` change to land: the cost is paid once.

### 4. Manual verification, if step 3's automated pass fails

Settled previously: this is done **via agent-browser**, against the Blockscout UI at `https://explorer.testnet.chain.robinhood.com`.

Six contracts to verify: `Rushood`, `Treasury`, `RushoodGame`, `RushoodVesting`, `RushoodLPLock`, `RushoodTimelock`.

What the form needs, and where it comes from:

- **Compiler** `0.8.24`, optimizer **enabled**, **200** runs, `evmVersion` **cancun**.
  All four are in `hardhat.config.ts` and all four must match or the bytecode will not.
- **Constructor arguments**, ABI-encoded.
  `verify-and-publish.ts` already assembles these per contract in its `targets` array; take them from there rather than rebuilding them.
- **Standard JSON input** is the reliable route on Blockscout.
  Build artifacts are under `artifacts/build-info/`; read each unit through its own artifact's `.dbg.json` rather than picking a build-info file directly, because stale ones from earlier compiles are left behind and describe code that no longer exists.

## After the run

- `docs/deployments/robinhoodTestnet.md` is regenerated by step 3. **Drop the stale banner** - it names #47's packing and is about the old source.
- Confirm the regenerated file still discloses the unlocked LP remainder.
- **Issue #47 closes here, and not before.**
  Its last acceptance criterion is the republished address list, which is this.
- Update `packages/web` if it pins any of the six addresses, and check `lib/chain.ts`.
- The relayer needs repointing at the new game address before the app works against this deployment.

## What this does not clear

The redeploy freezes the source.
It does not start the audit, and it clears none of the owner-owned gates: the independent security audit, gambling and legal compliance, trademark review of "RUSHOOD", the 25 ETH mainnet LP seed, or the systemd install drill.
The shipped disclosure says the contracts are not yet audited.
Keep it that way.
