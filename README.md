# RUSHOOD

A mainnet, real-value **Play-to-Earn "pick your odds" number-prediction game** on **Robinhood Chain** (Arbitrum Orbit L2, chain 4663). Players bet the `RUSH` chip token, choose their odds (1-in-2 up to a 1-in-1000 moonshot) at a flat 5% house edge, and get an instant, provably-fair, on-chain-settled draw.

> Full design: [`docs/spec/RUSHOOD-game-spec.md`](docs/spec/RUSHOOD-game-spec.md). Work is tracked as GitHub issues (see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)).

## Monorepo layout

| Package | Stack | Purpose |
|---|---|---|
| `packages/contracts` | Solidity + Hardhat | RUSH token, game, treasury, randomness verifier |
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

## Walking skeleton — play one bet locally (#18)

The thinnest complete path: connect a wallet, place one fixed-tier bet in RUSH, have it
settled by the on-chain commit-reveal, and see win/loss. Run four processes:

```bash
# 1. Local chain
npm run node --workspace @rushood/contracts            # hardhat node on :8545

# 2. Deploy RUSH + Treasury + Game and fund the treasury/dev player
npm run deploy:skeleton --workspace @rushood/contracts  # writes deployments/localhost.json

# 3. Relayer stand-in — watches BetPlaced and reveals the next hash-chain node
npm run relayer --workspace @rushood/contracts

# 4. Web app
npm run dev --workspace @rushood/web                    # http://localhost:3000
```

Open the app, click **Connect Mock Connector** (Hardhat account #1, unlocked on the local
node), and **Place bet (100 RUSH)**. The relayer settles it and the panel shows the result.
Contract addresses default to the deterministic local-deploy addresses; override with
`NEXT_PUBLIC_GAME_ADDRESS` / `NEXT_PUBLIC_RUSH_ADDRESS` / `NEXT_PUBLIC_RPC_URL`.

The single hardcoded tier, single-active-bet flow, and reproducible dev seed are skeleton
simplifications — odds tiers, payout math, and a real relayer deepen in later tickets.

## Status

Greenfield build, sliced into tracer-bullet tickets (`ready-for-agent`). This scaffold is ticket #16; the frontier advances from there.
