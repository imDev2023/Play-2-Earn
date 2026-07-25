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

## Status

Greenfield build, sliced into tracer-bullet tickets (`ready-for-agent`). This scaffold is ticket #16; the frontier advances from there.
