# RUSHOOD - Buildable Spec & Implementation Plan

**Game #1: a mainnet, real-value Play-to-Earn "pick your odds" number-prediction game on Robinhood Chain.**

> This document is the destination artifact of wayfinder [MAP #1](https://github.com/imDev2023/Play-2-Earn/issues/1). Every design decision below is **locked** - a build session can execute it with nothing left to decide. Each section links the deciding ticket. Where this spec resolves a mechanism the decisions left implicit, it is flagged **[spec-resolved]**.

---

## 0. Scope & non-goals

**In scope:** a single, standalone number-prediction game - smart contracts, a randomness backend service, and a Next.js/wagmi frontend - plus the RUSHOOD token and its launch.

**Out of scope** (owner-driven, per the map): legal & gambling-regulation compliance; security audit & formal verification (**required before real-value mainnet launch** - see §11); the platform layer (staking *implementation*, cross-game treasury aggregation, additional games); go-to-market & exchange/Robinhood-app listings.

---

## 1. Locked decisions at a glance

| Area | Decision | Ticket |
|---|---|---|
| **Code basis** | Build from scratch (fresh contracts + Next.js/wagmi) | [#9](https://github.com/imDev2023/Play-2-Earn/issues/9) |
| **Chain** | Robinhood Chain **mainnet** - Arbitrum Orbit L2, chain **4663** (testnet **46630**), gas in **ETH** | [#7](https://github.com/imDev2023/Play-2-Earn/issues/7) |
| **Economics** | Deflationary chip + treasury flywheel: fixed-supply no-mint, house-banked, dual-burn, ~5% edge, cap-based solvency | [#5](https://github.com/imDev2023/Play-2-Earn/issues/5) |
| **Mechanic** | "Pick your odds" single-number prediction; tiers 1-in-2…1000; flat 5% edge | [#6](https://github.com/imDev2023/Play-2-Earn/issues/6) |
| **Token** | RUSHOOD (`RUSH`), 1B / 18 dec, no-mint, `ERC20Burnable`; multisig+timelock; Uniswap-seeded, LP locked | [#8](https://github.com/imDev2023/Play-2-Earn/issues/8) |
| **Randomness** | In-house per-play 2-party commit-reveal, verified & settled on-chain (Entropy-shaped); VRF-via-CCIP-from-Base as future upgrade | [#12](https://github.com/imDev2023/Play-2-Earn/issues/12) |

---

## 2. System overview

Three cooperating pieces:

1. **On-chain contracts (Solidity + Hardhat)** - the RUSHOOD token, the game logic, the treasury bankroll, the on-chain randomness verifier/settlement, and governance (multisig + timelock).
2. **Randomness backend service** - a relayer that manages the server hash-chain, watches for bets, and submits on-chain settlements; plus a public verification endpoint/tool.
3. **Frontend (Next.js + wagmi)** - wallet connect, buy RUSH on Uniswap, the play UI (instant-reveal drama), the per-play client-entropy flow, a player-facing fairness verifier, and the admin/treasury console.

```
Player ── wallet (ETH gas + RUSH) ──► Frontend (Next.js/wagmi)
   │                                      │  placeBet(tier, amount, clientEntropy)
   │                                      ▼
   │                               ┌─────────────┐   payout (capped)   ┌───────────┐
   │                               │  Game.sol   │◄────────────────────│ Treasury  │
   │  watches BetPlaced            │  (RNG verify│   burn slice        │ (bankroll)│
   ▼                               │  + settle)  │────────────────────►│  + buyback│
Backend relayer ── settleBet(id, serverReveal) ──►│             │       └───────────┘
   │  (server hash-chain)          └─────────────┘
   └── /verify (public fairness tool)
```

---

## 3. Token: RUSHOOD (`RUSH`) - [#8](https://github.com/imDev2023/Play-2-Earn/issues/8)

- **Standard:** ERC20 + `ERC20Burnable` (OpenZeppelin). Name `RUSHOOD`, symbol `RUSH`, **18 decimals**.
- **Supply:** **1,000,000,000 RUSH**, minted **once** at deploy to the distributor. **No mint function exists** - supply can only ever decrease via burns.
- **[spec-resolved] The token contract is ownerless/immutable** - no `Ownable`, no pause, no admin hooks on the token itself. Credible neutrality: all game/treasury controls live in the *other* contracts, so RUSH itself can never be frozen or inflated. (This is stronger than #8's "multisig+timelock owner", which applies to the **game/treasury** governance, not the token.)
- **Burn paths:** `burn`/`burnFrom` called by the Game (per-play burn) and the Treasury (profit burn). True burn (reduces `totalSupply`), not a dead-address transfer.

### Genesis allocation (transferred at deploy)

| Bucket | % | RUSH | Destination | Lock |
|---|---:|---:|---|---|
| House treasury / bankroll | 45% | 450,000,000 | Treasury contract | - (bankroll) |
| Uniswap liquidity | 25% | 250,000,000 | LP position | **LP locked 1-2 yr** |
| Community / marketing / airdrop | 15% | 150,000,000 | Multisig-controlled distributor | per-campaign |
| Team / dev | 10% | 100,000,000 | `VestingWallet` | **6-mo cliff, then linear 18-24 mo** |
| Staking bootstrap reserve | 5% | 50,000,000 | Multisig (held for platform layer) | - |

---

## 4. Game mechanic - [#6](https://github.com/imDev2023/Play-2-Earn/issues/6)

**"Pick your odds":** the player chooses a difficulty **tier** (their odds), places a RUSH bet, picks (or is assigned) a number in `[0, N)`, and a verifiable random draw decides the outcome. One play = one instant draw.

Flat **5% house edge** across all tiers ⇒ **payout multiplier = 0.95 × N** (where a tier is "1-in-N"). Expected return to player = `(1/N) × 0.95N = 0.95` on every tier.

| Tier (1-in-N) | Win probability | Payout multiplier | Vibe |
|---:|---:|---:|---|
| 2 | 50% | **1.9×** | Coin-flip |
| 4 | 25% | **3.8×** | |
| 10 | 10% | **9.5×** | |
| 50 | 2% | **47.5×** | |
| 100 | 1% | **95×** | |
| **1000** | **0.1%** | **950×** | **Moonshot** 🚀 |

- **Draw:** `outcome = R mod N`, where `R` is the verified per-play random word (§6). Player wins if `outcome == pickedNumber` (default pick = 0, or player-selected - cosmetic, since all numbers are equiprobable).
- **Solvency caps** (§5): `maxBet(tier) = maxPayout / multiplier`, so the moonshot has the smallest max bet. Tiers, multipliers, and the edge are governance params (timelock-gated).
- **Deferred:** multi-number picks, progressive jackpots, parimutuel pools (future games).

---

## 5. Economics & solvency - [#5](https://github.com/imDev2023/Play-2-Earn/issues/5)

House-banked: the player bets against the **Treasury** bankroll, in RUSH. The 5% edge means the treasury grows in expectation.

### Per-play flows (at settlement)
- **Loss:** the full stake becomes house income.
- **Win:** Treasury pays `stake × multiplier` to the player.
- **Per-play burn [spec-resolved]:** burn a **fixed fraction of the stake** on every settled play - target **~2.5% of stake ≈ half the 5% edge** (governance param). The remaining house income accrues to the Treasury bankroll. Over expectation this burns ≈ 50% of the edge, matching #5.

### Treasury profit burn [spec-resolved - clarifies #5]
Because the game is **RUSH-banked**, house profits accrue **in RUSH**, so there is nothing to "buy back" - #5's "buyback-and-burn" collapses to a **direct treasury burn**: periodically burn ~50% of net RUSH profit directly (governance-triggered). Economically equivalent, simpler, no swap. *A true market buyback (spending ETH to buy RUSH off Uniswap and burn) remains an **optional** future lever if the treasury ever holds ETH revenue - not part of the core loop.*

### Solvency (locked requirement)
- Seeded treasury = 45% of supply (§3).
- **`maxPayout ≤ ~1% of the Treasury's current RUSH balance`** ⇒ no single win (even a 950× moonshot) can dent the bankroll.
- `maxBet(tier) = maxPayout / multiplier`, recomputed as the treasury balance moves.
- **Pool-depletion behavior:** below a governance-set treasury floor, reject bets whose potential payout exceeds the safe cap, and/or **pause** - never accept a bet the treasury can't cover.

### Minimum-bet floor
- `minBet = per-play cost ÷ edge`. Per-play cost on 4663 (an L2, in-house RNG so **no oracle fee**) is **cents** ⇒ **minBet well under $1** (target the equivalent of ~$0.25 to $0.50; **[spec-resolved]** finalized at deploy against live gas).
- Enforced as a **RUSH-denominated `minBet` param** that governance adjusts to hold the USD-equivalent floor as the RUSH/ETH price moves.

### "Earn" framing (honest)
Winners win; all holders gain from deflation + demand; stakers (platform layer) earn real yield from rake. Not guaranteed token accrual for the average player.

---

## 6. Randomness & fairness - [#12](https://github.com/imDev2023/Play-2-Earn/issues/12)

**In-house per-play 2-party commit-reveal, verified & settled on-chain (Entropy-shaped).** No block variables (`prevrandao` is a *constant* on 4663). Behind an `IRandomnessSource` interface so a real oracle can be swapped in later (see §6.4).

### 6.1 Server hash-chain (pre-committed)
The backend generates a secret seed `s₀` and a **reverse hash-chain**: `sᵢ = keccak256(sᵢ₋₁)`, publishing the tip `sₙ` on-chain as the standing commitment. It reveals preimages in reverse: to settle play *k* it reveals `sₙ₋ₖ`, and the contract checks `keccak256(revealed) == lastCommitted`, then stores `revealed` as the new `lastCommitted`. This proves every value was fixed **in advance** - the server can never change a future draw.

### 6.2 Per-play flow (ordering is the security)
1. **`placeBet(tier, pickedNumber, amount, clientEntropy)`** - player locks `amount` RUSH; contract records the bet with the player's `clientEntropy` and the current chain position. The server's value for this play is **already committed** (in the chain) but still secret; the player's entropy is **now fixed** and was unknown to the server when it committed the chain. ⇒ **neither side can grind toward an outcome.**
2. **`settleBet(betId, serverReveal)`** - sent by the backend relayer (see gas note). Contract: verifies `keccak256(serverReveal) == lastCommitted`; computes `R = keccak256(serverReveal, clientEntropy, betId)`; `outcome = R mod N`; pays out (capped) or keeps the stake; executes the per-play burn; advances `lastCommitted = serverReveal`. Emits `BetSettled` with all inputs.
3. **`refund(betId)`** - if the server hasn't settled within `settleTimeout` blocks, the player reclaims the locked stake. **Closes the selective-abort hole** - the house cannot walk away from a losing round.

**[spec-resolved] Gas:** the **backend relayer pays the `settleBet` gas** (server-sponsored settlement). The player pays gas only for `placeBet` (and `refund` if ever needed) - one-tap play UX. Relayer ETH cost is an operational expense folded into house economics.

### 6.3 Trust model (disclose to players)
- ✅ Can't change an outcome after commit (hash-chain); ✅ can't abort a losing round (on-chain settlement + timeout); ✅ can't pre-grind against a player (per-play player entropy).
- ⚠️ Residual = the **industry-standard provably-fair** trust level, not the zero-trust of a real on-chain VRF. Stated openly in-app + a public verifier.

### 6.4 Upgrade path
`IRandomnessSource` isolates the mechanism. A future **VRF-via-CCIP-from-Base** adapter (Chainlink VRF on Base → CCIP → 4663; Base is the only VRF-carrying chain with a mainnet CCIP lane to 4663) or a native **Pyth Entropy** deployment can replace the in-house verifier **without game-logic changes**.

---

## 7. Contract architecture

Fresh Solidity (^0.8.24), Hardhat, OpenZeppelin. Suggested contracts:

| Contract | Responsibility | Owner |
|---|---|---|
| **`RUSHOOD.sol`** | ERC20Burnable, fixed 1B supply, no mint, **immutable/ownerless** | none |
| **`Treasury.sol`** | Holds RUSH bankroll; pays capped payouts on Game's authorized call; enforces `maxPayout`/floor; profit burn | Timelock |
| **`Game.sol`** | Tier config, edge, caps, min-bet; `placeBet`/`settleBet`/`refund`; embeds/holds the randomness verifier; per-play burn; pause | Timelock |
| **`IRandomnessSource` + `CommitRevealVerifier`** | Hash-chain commitment, reveal verification, `R` computation - the swappable seam (§6.4) | Timelock |
| **`VestingWallet`** (OZ) | Team allocation, 6-mo cliff + linear | beneficiary |
| **LP locker** | Locks the Uniswap LP position 1-2 yr | Timelock |
| **Governance** | **Safe multisig** → **`TimelockController`** owns Treasury/Game/verifier; timelock gates sensitive params (caps, edge, tiers) | - |

**Key invariants to test:** supply is fixed & monotonically non-increasing; `payout ≤ maxPayout ≤ 1% treasury`; a bet can always be `refund`ed after timeout; `settleBet` reverts unless the reveal matches the committed hash; only the Game can pull from the Treasury; sensitive setters are timelock-only.

---

## 8. Randomness backend service

- **Stateful relayer** (Node/TS): generates & stores `s₀` securely (KMS/HSM), builds the hash-chain, publishes the tip, watches `BetPlaced`, submits `settleBet` promptly (funded with ETH for gas), and rotates chains before exhaustion.
- **Reliability:** if the relayer is down, players are protected by `refund` after `settleTimeout`; monitor + alert on settlement lag and relayer ETH balance.
- **Public verifier** (`/verify`): given a settled bet's `serverReveal`, `clientEntropy`, `betId`, recomputes `R`, `outcome`, and checks the hash-chain link - anyone can independently confirm fairness. Open-source it.
- **Never** expose unrevealed chain values; treat `s₀` as the crown-jewel secret.

---

## 9. Frontend (Next.js + wagmi)

- **Wallet & network:** wagmi + viem; connectors (MetaMask etc.); enforce chain **4663**, with add-network + "get ETH for gas" guidance.
- **Acquire RUSH:** deep-link / embed the **Uniswap** swap (live on 4663) for ETH→RUSH; show price + a "how to get RUSH" flow.
- **Play UI (the excitement):** tier picker showing odds + multipliers (moonshot front-and-center), bet input (min/max enforced live from contract params), an **instant, dramatic reveal** animation on `BetSettled`, win/loss celebration, per-play client-entropy generated client-side and shown.
- **Fairness:** a "provably fair" panel - commitment, your client entropy, and a one-click link to the public verifier; plain-language trust disclosure (§6.3).
- **History:** the player's bets + outcomes, each independently verifiable.
- **Admin/treasury console** (gated to the multisig): treasury balance, caps/edge/min-bet params (timelock-queued), profit-burn trigger, pause, relayer health.

---

## 10. Deployment & configuration plan

**Chain params:** mainnet 4663 / testnet 46630; RPC via **Alchemy** (`https://robinhood-mainnet.g.alchemy.com/v2/{KEY}`); verify on **Blockscout** (`robinhoodchain.blockscout.com`); gas + deployer funded in **ETH**.

**Sequence:**
1. Deploy `RUSHOOD` (mint 1B to distributor).
2. Deploy **Safe multisig** + **TimelockController**; set as owner of Game/Treasury/verifier.
3. Deploy `Treasury`, `Game` + `CommitRevealVerifier`, wire authorizations; set initial tiers, 5% edge, `maxPayout` (1% rule), `minBet`, `settleTimeout`, per-play burn rate.
4. Transfer genesis allocation (§3): 45% → Treasury, 15% → community distributor, 10% → `VestingWallet` (cliff+linear), 5% → multisig.
5. **[decide at deploy] Seed the Uniswap pool** with the 25% LP allocation: **pair asset** (recommend **RUSH/ETH** - ETH is native gas on 4663; RUSH/USDC an option) and **initial price / seed amount** (launch-time capital + market-timing call). **Lock the LP** position 1-2 yr.
6. Publish the first server hash-chain tip; start the relayer (ETH-funded).
7. Verify all contracts on Blockscout; publish addresses + the open-source verifier.

**Testnet (46630) first:** full end-to-end dry run - deploy, seed a test pool, play across all tiers, force a `refund` (relayer-down path), exercise caps/pause, and run the public verifier against real settlements.

---

## 11. Implementation sequencing & launch checklist

**Build order:**
1. `RUSHOOD` token + tests.
2. `CommitRevealVerifier` + `IRandomnessSource` + fairness tests (hash-chain, ordering, tamper-rejection).
3. `Treasury` + `Game` (bet/settle/refund, caps, burns) + invariant tests (§7).
4. Governance wiring (Safe + Timelock).
5. Backend relayer + public verifier.
6. Frontend (connect → buy → play → verify → history), then admin console.
7. Full testnet dry run (§10).

**Pre-mainnet gate (owner-owned, out of scope but REQUIRED):**
- [ ] **Security audit + formal verification** of all contracts.
- [ ] **Legal / gambling-regulation** clearance for target jurisdictions.
- [ ] Trademark review of the **RUSHOOD** name (Robinhood association).
- [ ] Finalize `minBet`/caps against live 4663 gas + RUSH price.
- [ ] Decide LP pair-asset + initial price (§10.5); confirm LP lock.
- [ ] Relayer ops runbook (key custody, ETH funding, settlement-lag alerts).

**Launch:** deploy per §10 → seed + lock LP → start relayer → open play → publish verifier & addresses. Then hand to the platform layer (staking, more games) as separate efforts.

---

*End of spec. All map decisions are captured above; the deciding tickets hold the full rationale. This document is the buildable hand-off.*
