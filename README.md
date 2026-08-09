# RUSHOOD

A mainnet, real-value **Play-to-Earn "pick your odds" number-prediction game** on **Robinhood Chain** (Arbitrum Orbit L2, chain 4663). Players bet the `RUSH` chip token, choose their odds (1-in-2 up to a 1-in-1000 moonshot) at a flat 5% house edge, and get an instant, provably-fair, on-chain-settled draw.

> Full design: [`docs/spec/RUSHOOD-game-spec.md`](docs/spec/RUSHOOD-game-spec.md). Work is tracked as GitHub issues (see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)).

## Monorepo layout

| Package | Stack | Purpose |
|---|---|---|
| `packages/contracts` | Solidity + Hardhat | RUSH token, game, treasury, randomness verifier |
| `packages/verifier` | TypeScript (no deps but viem) | Public fairness verifier + `verify` CLI |
| `packages/web` | Next.js + wagmi + Playwright | Player app + admin console |

## Getting started

```bash
npm install            # installs all workspaces
npm run build          # compile contracts + build the web app
npm test               # contract tests (Hardhat) + web E2E (Playwright)
npm run typecheck      # tsc across workspaces
npm run lint           # solhint + next lint
```

For the web E2E tests, install the browser once: `npm run test:install --workspace @rushood/web`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build, contract tests, and web E2E on every push and PR.

## Walking skeleton - play one bet locally (#18)

The thinnest complete path: connect a wallet, place one fixed-tier bet in RUSH, have it
settled by the on-chain commit-reveal, and see win/loss. Run four processes:

```bash
# 1. Local chain
npm run node --workspace @rushood/contracts            # hardhat node on :8545

# 2. Deploy RUSH + Treasury + Game and fund the treasury/dev player
npm run deploy:skeleton --workspace @rushood/contracts  # writes deployments/localhost.json

# 3. Relayer stand-in - watches BetPlaced and reveals the next hash-chain node
npm run relayer --workspace @rushood/contracts

# 4. Web app
npm run dev --workspace @rushood/web                    # http://localhost:3000
```

Open the app, click **Connect test wallet** (Hardhat account #1, unlocked on the local
node), and **Place bet**. The relayer settles it (sponsoring gas) and the panel shows the
result. The button names whichever wallet it will open, so in a browser with a real wallet
installed it reads **Connect MetaMask** instead - the test wallet is a last resort, offered
only when there is no real one, and only when the app targets a local node at all. Contract addresses default to the deterministic local-deploy addresses;
override with `NEXT_PUBLIC_GAME_ADDRESS` / `NEXT_PUBLIC_RUSH_ADDRESS` / `NEXT_PUBLIC_RPC_URL`.

**Relayer + refund (#19).** The relayer manages the server hash chain and rotates to a fresh
chain before exhaustion (`RELAYER_CHAIN_LENGTH`, `RELAYER_ROTATION_MARGIN`). Players pay gas
only for `placeBet`; settlement is on the relayer. If the relayer goes dark, any bet left
unsettled past `SETTLE_TIMEOUT` (1 hour) can be reclaimed on-chain via `refund(betId)`.

The single hardcoded tier, single-active-bet flow, and reproducible dev seed are skeleton
simplifications - odds tiers, payout math, and governance over the relayer deepen in later tickets.

## Verifying a roll (#24)

Every settled roll is recomputable by anyone from data the chain publishes. `BetPlaced`
carries the commitment the bet was locked against, `BetSettled` carries the reveal and
the roll, and `RushoodGame.bets(betId)` holds the whole set - no archive node, no
indexer, no trusting this app.

- **In the app** - the fairness panel shows the commitment, your own entropy, and the
  reveal, and links to `/verify` with every input baked into the URL.
- **In a browser** - `/verify` recomputes the draw locally. Nothing is sent anywhere; the
  page works with no wallet and no chain.
- **On the command line** - the same links work verbatim:

  ```bash
  npm run verify --workspace @rushood/verifier -- --url "<paste a verify link>"
  ```

The formula lives in `RushoodGame.outcomeOf` (a `public pure` function `settleBet`
itself calls) and in [`@rushood/verifier`](packages/verifier/README.md); the contract
suite's `test/Fairness.ts` pins the two implementations together, so they can't drift.

## Status

Greenfield build, sliced into tracer-bullet tickets (`ready-for-agent`). This scaffold is ticket #16; the frontier advances from there.
