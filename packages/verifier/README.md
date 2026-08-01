# @rushood/verifier

The public fairness verifier for [RUSHOOD](../../README.md). Recompute any roll from
its public inputs and check it against the commitment the house made *before* the bet.

It talks to nothing. No network, no wallet, no state - give it the numbers the chain
published and it re-runs the draw locally. That's the point: you shouldn't have to
trust rushood's website (or its RPC, or its relayer) to believe a result.

## How a roll is decided

RUSHOOD settles each play with a two-party commit-reveal:

```
commitment == keccak256(serverReveal)                        // the hash-chain link
R          == keccak256(serverReveal, clientEntropy, betId)
roll       == R mod N                                        // N = the tier's odds
win        == roll == 0                                      // a 1-in-N shot
```

Neither side can grind the result. The server's reveal is fixed before your bet exists -
only its hash, the standing commitment, is public. Your entropy is fixed at bet time,
before the reveal becomes public. Mixing `betId` in domain-separates bets, so an
outcome can't be replayed onto a different one.

## Where the inputs come from

Everything is on-chain, in three places, any of which is enough:

| Input | `BetPlaced` | `BetSettled` | `RushoodGame.bets(betId)` |
|---|---|---|---|
| `betId` | ✓ | ✓ | (the key) |
| `tier` | ✓ | | ✓ |
| `clientEntropy` | ✓ (`clientSeed`) | | ✓ (`clientSeed`) |
| `commitment` | ✓ (`commit`) | | ✓ (`commit`) |
| `serverReveal` | | ✓ (`reveal`) | ✓ (`reveal`) |
| reported `win` / `roll` | | ✓ | |

## Command line

```bash
npm run verify --workspace @rushood/verifier -- \
  --betId 7 --tier 5 --clientEntropy 42 \
  --serverReveal 0x… --commitment 0x…
```

Or paste a share link straight off the in-app fairness panel - the `/verify` page and
this CLI accept exactly the same parameters:

```bash
npm run verify --workspace @rushood/verifier -- --url "https://…/verify?betId=7&…"
```

Exit code `0` means every check passed; `1` means something didn't add up.

## Library

```ts
import { verifyRoll } from "@rushood/verifier";

const verdict = verifyRoll({
  betId: 7n,
  tier: 5,
  clientEntropy: 42n,
  serverReveal: "0x…",
  commitment: "0x…",
  reported: { win: false, roll: 248n }, // optional cross-check
});

verdict.ok;              // every check passed
verdict.commitmentValid; // the reveal really is the pre-image of the commitment
verdict.computed.roll;   // the draw, recomputed
verdict.failures;        // ["commitment-mismatch"], ["roll-mismatch"], …
```

`verifyRoll` never throws on bad input - an unknown tier is reported as a failure like
any other, so a UI can render one verdict shape for every outcome.

## Why you can trust this matches the chain

The formula lives twice: here, and in `RushoodGame.outcomeOf` - a `public pure`
function `settleBet` itself calls, so the game settles on the same number a skeptic
recomputes. The contract test suite
([`test/Fairness.ts`](../contracts/test/Fairness.ts)) pins the two together: it drives
real bets through the contract and asserts this module reproduces the emitted result,
tier by tier. If they ever drift apart, CI fails.
